"""Offline known-resource reconciliation, PATCH faults and backup recovery gates."""
import contextlib
import copy
import json
from pathlib import Path
import sys
import tempfile
import hashlib
import unittest
from unittest.mock import Mock, patch
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).parent))
import art337_immutable_recovery as r
from test_art337_immutable_recovery import artifact, fixture


@contextlib.contextmanager
def repair_fixture():
    with fixture() as (root, manifest, old, update):
        operations = root/'immutable-operations'; operations.mkdir(mode=0o700)
        intent = {'bodySha256': '48caa82b444531844094d5b774fe6d658bbdbe0afed9a88addb82a513ad93cd5',
                  'reference': r.RECOVERY_REFERENCE, 'sourceUuid': r.ORIGINAL_APP}
        (operations/'commerce-resource-create.intent.json').write_bytes(r.canonical(intent))
        (operations/'commerce-resource-create.outcome.json').write_bytes(r.canonical({'domains':None,'uuid':r.RECOVERY_APP}))
        parent = {'environment_id':6, 'destination_id':0}
        app = {'uuid':r.RECOVERY_APP, 'name':'flexperiment-commerce-v2-canary-immutable',
               'status':'exited:unhealthy', 'environment_id':6, 'destination_id':0, 'build_pack':'dockerimage',
               'ports_exposes':'3002', 'custom_network_aliases':r.ORIGINAL_APP,
               **r.coolify_image_fields(r.RECOVERY_REFERENCE),
               'settings':{'is_auto_deploy_enabled':True,'is_preview_deployments_enabled':False}}
        store={'env':[], 'storage':{'persistent_storages':[],'file_storages':[]}, 'app':app}
        rpc=Mock(); rpc.container.return_value=None
        def api(method,path,body=None):
            if method=='PATCH':
                app['settings'].update({k:v for k,v in body.items() if k!='instant_deploy'})
                return {'message':'Application updated.'}
            if path.endswith('/envs'):return store['env']
            if path.endswith('/storages'):return store['storage']
            return store['app']
        rpc.api.side_effect=api
        original=Path.lstat
        def owner_stat(path,**kw):
            stat=original(path,**kw)
            if Path(path)==operations:return type('Stat',(),{'st_uid':0,'st_mode':stat.st_mode})()
            return stat
        with patch.object(r,'stopped_parent',return_value=parent), patch.object(r,'verify_timer_isolation'), \
                patch.object(Path,'lstat',new=owner_stat):
            yield root,manifest,rpc,app,store,update


class KnownResource(unittest.TestCase):
    def test_controller_blob_reads_exact_commit_bytes_without_credentials_or_redirect(self):
        raw=b'isolated public controller bytes\n'
        response=Mock();response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False);response.read.return_value=raw
        opener=Mock();opener.open.return_value=response
        with patch.object(r.urllib.request,'build_opener',return_value=opener):
            expected=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
            self.assertEqual(r.github_blob('6'*40,'art337_canary_timers.py'),expected)
        request=opener.open.call_args.args[0]
        self.assertEqual(request.full_url,'https://raw.githubusercontent.com/ArtGurianov/flexperiment/'+'6'*40+'/scripts/v2/art337_canary_timers.py')
        self.assertFalse(request.has_header('Authorization'))
    def test_lost_timer_isolation_response_preserves_intent_and_never_retries(self):
        with repair_fixture() as (root,_,rpc,_,_,_),patch.object(r.timers,'capture',return_value={'units':{}}), \
                patch.object(r.timers,'isolate',side_effect=TimeoutError('lost-command')) as isolate:
            with self.assertRaises(TimeoutError):r.isolate_timers(rpc)
            with self.assertRaisesRegex(r.Refusal,'REPLAY_OR_UNKNOWN'):r.isolate_timers(rpc)
            isolate.assert_called_once()
            self.assertTrue((root/'immutable-operations'/'commerce-timer-isolate.intent.json').exists())
            self.assertFalse((root/'immutable-operations'/'commerce-timer-isolate.outcome.json').exists())
    def test_pinned_records_readonly_reconciliation_never_creates(self):
        with repair_fixture() as (_,_,rpc,_,_,_):
            result=r.verify_existing_resource(rpc)
            self.assertEqual(result['applicationUuid'],r.RECOVERY_APP)
            self.assertIs(result['autoDeploy'],True)
            self.assertTrue(all(c.args[0]=='GET' for c in rpc.api.call_args_list))

    def test_create_record_hash_wrong_uuid_reference_missing_or_changed_refuses(self):
        for name,raw in [('intent',b'{}'),('outcome',r.canonical({'domains':None,'uuid':'x'*24})),('outcome',b'')]:
            with self.subTest(name=name,raw=raw),repair_fixture() as (root,_,rpc,_,_,_):
                (root/'immutable-operations'/('commerce-resource-create.'+name+'.json')).write_bytes(raw)
                with self.assertRaises(r.Refusal):r.verify_existing_resource(rpc)
                rpc.api.assert_not_called()

    def test_wrong_topology_digest_settings_override_runtime_or_provisioning_refuses_before_patch(self):
        changes=[lambda a,s,rpc:a.update(uuid='x'*24),lambda a,s,rpc:a.update(environment_id=9),
            lambda a,s,rpc:a.update(destination_id=9),lambda a,s,rpc:a.update(status='running:healthy'),
            lambda a,s,rpc:a.update(docker_registry_image_tag='latest'),lambda a,s,rpc:a.update(custom_labels='unknown'),
            lambda a,s,rpc:a['settings'].update(is_preview_deployments_enabled=True),
            lambda a,s,rpc:a['settings'].update(is_auto_deploy_enabled=False),
            lambda a,s,rpc:s.update(env=[{'key':'UNKNOWN'}]),
            lambda a,s,rpc:s['storage']['file_storages'].append({'fs_path':'unknown'}),
            lambda a,s,rpc:setattr(rpc.container,'return_value','running-id')]
        for change in changes:
            with self.subTest(change=change),repair_fixture() as (_,_,rpc,a,s,_):
                change(a,s,rpc)
                with self.assertRaises(r.Refusal):r.repair_existing_resource(rpc)
                self.assertTrue(all(c.args[0]=='GET' for c in rpc.api.call_args_list))

    def test_successful_patch_separate_fsynced_receipt_before_provisioning(self):
        with repair_fixture() as (root,_,rpc,app,_,_):
            result=r.repair_existing_resource(rpc)
            self.assertEqual(result['state'],'EXISTING_SETTINGS_REPAIRED_NOT_ADMITTED')
            writes=[c for c in rpc.api.call_args_list if c.args[0]!='GET']
            self.assertEqual(len(writes),1)
            self.assertEqual(writes[0].args,('PATCH','/applications/'+r.RECOVERY_APP,
                {'is_auto_deploy_enabled':False,'is_preview_deployments_enabled':False,'instant_deploy':False}))
            self.assertTrue((root/'immutable-operations'/'commerce-resource-settings-repair.intent.json').exists())
            r.verify_repair_receipt(rpc)
            app['settings']['is_auto_deploy_enabled']=True
            with self.assertRaisesRegex(r.Refusal,'SETTINGS_CHANGED_AFTER_REPAIR'):r.verify_repair_receipt(rpc)

    def test_lost_patch_ack_applied_or_unapplied_preserves_intent_never_retry(self):
        for applied in (True,False):
            with self.subTest(applied=applied),repair_fixture() as (root,_,rpc,app,_,_):
                normal=rpc.api.side_effect
                def lost(method,path,body=None):
                    if method=='PATCH':
                        if applied:normal(method,path,body)
                        raise TimeoutError('lost-ack')
                    return normal(method,path,body)
                rpc.api.side_effect=lost
                with self.assertRaises(TimeoutError):r.repair_existing_resource(rpc)
                with self.assertRaises(r.Refusal):r.repair_existing_resource(rpc)
                self.assertEqual(len([c for c in rpc.api.call_args_list if c.args[0]=='PATCH']),1)
                self.assertTrue((root/'immutable-operations'/'commerce-resource-settings-repair.intent.json').exists())
                self.assertFalse((root/'immutable-operations'/'commerce-resource-settings-repair.outcome.json').exists())
                self.assertEqual(r.reconcile('commerce-resource-settings-repair')['state'],'HOLD')

    def test_false_success_or_readback_drift_never_receipted(self):
        with repair_fixture() as (root,_,rpc,app,_,_):
            normal=rpc.api.side_effect
            def ignored(method,path,body=None):
                if method=='PATCH':return {'message':'OK'}
                return normal(method,path,body)
            rpc.api.side_effect=ignored
            with self.assertRaisesRegex(r.Refusal,'EXISTING_RESOURCE_DRIFT'):r.repair_existing_resource(rpc)
            self.assertFalse((root/'immutable-operations'/'commerce-resource-settings-repair.outcome.json').exists())

    def test_settings_flip_after_empty_get_stops_before_any_secret_copy(self):
        with repair_fixture() as (_,_,rpc,app,_,_):
            r.repair_existing_resource(rpc)
            app['settings']['is_auto_deploy_enabled']=True
            rpc.api.reset_mock()
            with self.assertRaisesRegex(r.Refusal,'SETTINGS_CHANGED_AFTER_REPAIR'):r.configure_delivery(rpc)
            self.assertTrue(all(c.args[0]=='GET' for c in rpc.api.call_args_list))

    def test_missing_or_changed_timer_receipt_blocks_patch_and_configure(self):
        with repair_fixture() as (_,_,rpc,_,_,_),patch.object(r,'verify_timer_isolation',side_effect=r.Refusal('TIMER_HOLD')):
            for operation in (r.repair_existing_resource,r.configure_delivery):
                with self.assertRaisesRegex(r.Refusal,'TIMER_HOLD'):operation(rpc)
            rpc.api.assert_not_called()

    def test_cli_create_is_readonly_refusal_not_a_second_post(self):
        with patch.object(sys,'argv',['controller','--operation','create']),patch.object(r,'original_rpc',return_value=Mock()), \
                patch.object(r,'create_delivery') as create,self.assertRaises(SystemExit):r.main()
        create.assert_not_called()


class BackupAndSchedules(unittest.TestCase):
    def test_incomplete_restore_receipt_cannot_admit_rearm_or_final_pass(self):
        with repair_fixture() as (root,_,_,_,_,_):
            directory=root/'immutable-operations'
            (directory/'commerce-timer-restore.intent.json').write_bytes(r.canonical({'applicationUuid':r.RECOVERY_APP,'profile':r.timers.FILES,'recovery':{}}))
            (directory/'commerce-timer-restore.outcome.json').write_bytes(r.canonical({'state':'ACTIVATION_RETURNED_REQUIRES_READBACK','timers':list(r.timers.TIMERS),'recordedAt':datetime.now(timezone.utc).isoformat()}))
            with self.assertRaisesRegex(r.Refusal,'TIMER_RESTORE_RECEIPT_DRIFT'):r.verify_timer_restore_receipt()
    def test_lost_rearm_service_start_preserves_intent_never_repeats(self):
        with repair_fixture() as (root,manifest,rpc,_,_,_),patch.object(r,'backup_adopted'), \
                patch.object(r,'verify_timer_restore_receipt'), \
                patch.object(r.timers,'run_rearmed_backup',side_effect=TimeoutError('lost-start')) as start:
            with self.assertRaises(TimeoutError):r.rearm_canary_backup(manifest,rpc)
            with self.assertRaisesRegex(r.Refusal,'REPLAY_OR_UNKNOWN'):r.rearm_canary_backup(manifest,rpc)
            start.assert_called_once()
            self.assertTrue((root/'immutable-operations'/'commerce-scheduled-backup-rearm.intent.json').exists())
    @contextlib.contextmanager
    def recovered(self):
        with fixture() as (root,manifest,_,_):
            now=datetime.now(timezone.utc).isoformat();filename='canary-20261014T080000Z-'+r.TARGET+'-'+'a'*8+'-'+'b'*4+'-'+'c'*4+'-'+'d'*4+'-'+'e'*12+'.sqlite.age'
            status={'verifiedAt':int(datetime.now(timezone.utc).timestamp()),'filename':filename,'sha256':'b'*64}
            common={'recordedAt':now,'sourceCommit':r.TARGET,'artifactSha256':r.q.digest(r.canonical(artifact())),
                'proofScriptSha256':r.q.digest(Path(r.__file__).with_name('art337-proof-continue.mjs').read_bytes()),
                'inputCommerceSha256':'d'*64,'schemaFingerprint':r.SCHEMA,'beforeMigrations':26,'afterMigrations':26,
                'integrity':'ok','foreignKeys':'ok','ledgerSequence':1,'mirrorSha256':'2'*64}
            proof={'recordedAt':now,'version':1,'scope':'canary','sourceCommit':r.TARGET,'applicationUuid':r.RECOVERY_APP,
                'backupStatusSha256':'a'*64,'archiveFilename':filename,'archiveSha256':'b'*64,'independentPlaintextSha256':'d'*64,
                'remoteObject':'cloud:art-backups/flexperiment/commerce-v2/canary/sqlite/'+filename,'remoteSha256':'b'*64,
                'restore':{**common,'result':'PASS','syntheticErasedAccounts':1,'currentUsers':0},
                'boot':{**common,'result':'BOOT_PASS','fence':'OPEN','leases':0}}
            path=root/'independent-proof.json';path.write_bytes(r.canonical(proof))
            operation=root/'immutable-operations';operation.mkdir()
            outcome={'state':'NEW_SCHEDULED_BACKUP_REQUIRES_INDEPENDENT_RECOVERY','applicationUuid':r.RECOVERY_APP,
                'requestedAt':status['verifiedAt'],'backupStatusSha256':'a'*64,'archiveFilename':filename,'archiveSha256':'b'*64}
            (operation/'commerce-scheduled-backup.outcome.json').write_bytes(r.canonical(outcome))
            backup=Mock();backup.s3.return_value=('b'*64+'  -\n').encode()
            with patch.object(r,'backup_adopted'),patch.object(r,'scheduled_status',return_value=(backup,status,'a'*64,root/'archive.age')), \
                    patch.object(r.q,'command',return_value=json.dumps({'state':'REMOTE_VERIFIED','sequence':1,'scope':'canary'})), \
                    patch.object(r.q,'json_file',return_value=({'entries':[{'hash':'f'*64}]},'2'*64)), \
                    patch.object(r.q,'current_fence',return_value=(('canary','OPEN',1,'f'*64,None),0,0)):
                yield manifest,path,proof,backup

    def test_exact_current_archive_remote_bytes_and_independent_restore_are_required(self):
        with self.recovered() as (manifest,path,_,backup):
            result=r.verify_backup_recovery(manifest,Mock(),path,first=True)
            self.assertEqual(result['archiveSha256'],'b'*64)
            self.assertIn('rclone cat',backup.s3.call_args.args[1])
        changes=[lambda p:p.update(backupStatusSha256='f'*64),lambda p:p.update(remoteSha256='f'*64),
            lambda p:p.update(remoteObject='cloud:art-backups/flexperiment/commerce-v2/production/sqlite/unknown'),
            lambda p:p['restore'].update(beforeMigrations=25),lambda p:p['boot'].update(fence='CLOSED'),
            lambda p:p['restore'].update(syntheticErasedAccounts=0),lambda p:p['boot'].update(leases=1),
            lambda p:p['boot'].update(artifactSha256='f'*64),lambda p:p['restore'].update(inputCommerceSha256='f'*64)]
        for change in changes:
            with self.subTest(change=change),self.recovered() as (manifest,path,proof,_):
                change(proof);path.write_bytes(r.canonical(proof))
                with self.assertRaises(r.Refusal):r.verify_backup_recovery(manifest,Mock(),path,first=True)

    def test_actual_remote_hash_or_newest_ledger_divergence_refuses(self):
        with self.recovered() as (manifest,path,_,backup):
            backup.s3.return_value=('f'*64+'  -\n').encode()
            with self.assertRaisesRegex(r.Refusal,'REMOTE_READBACK'):r.verify_backup_recovery(manifest,Mock(),path)
        with self.recovered() as (manifest,path,_,_),patch.object(r.q,'command',return_value=json.dumps({'state':'REMOTE_VERIFIED','sequence':2,'scope':'canary'})), \
                self.assertRaisesRegex(r.Refusal,'ERASURE_DRIFT'):
            r.verify_backup_recovery(manifest,Mock(),path)
    def test_service_success_without_new_backup_is_hold(self):
        with fixture() as (_,manifest,_,_),patch.object(r,'backup_adopted'),patch.object(r,'verify_timer_isolation'), \
                patch.object(r.timers,'run_backup'),patch.object(r,'once',side_effect=lambda n,req,action:action()), \
                patch.object(r,'scheduled_status',return_value=(None,{'verifiedAt':0},'a'*64,None)), \
                self.assertRaisesRegex(r.Refusal,'SCHEDULED_BACKUP_NOT_NEW'):
            r.run_canary_backup(manifest,Mock())

    def test_independent_recovery_failure_never_enables_timers(self):
        with fixture() as (_,manifest,_,_),patch.object(r,'verify_timer_isolation'), \
                patch.object(r,'verify_backup_recovery',side_effect=r.Refusal('PROOF_HOLD')),patch.object(r.timers,'restore') as activate, \
                self.assertRaisesRegex(r.Refusal,'PROOF_HOLD'):
            r.restore_canary_timers(manifest,Mock(),Path('/isolated'))
        activate.assert_not_called()

    def test_changed_proof_before_activation_blocks_start(self):
        with fixture() as (_,manifest,_,_),patch.object(r,'verify_timer_isolation'), \
                patch.object(r,'verify_backup_recovery',side_effect=[{'proofSha256':'a'*64},{'proofSha256':'b'*64}]), \
                patch.object(r,'once',side_effect=lambda n,req,action:action()),patch.object(r.timers,'restore') as activate, \
                self.assertRaisesRegex(r.Refusal,'TIMER_RESTORE_PROOF_CHANGED'):
            r.restore_canary_timers(manifest,Mock(),Path('/isolated'))
        activate.assert_not_called()

    def test_enable_response_is_not_final_schedule_or_backup_pass(self):
        with fixture() as (_,manifest,_,_),patch.object(r,'verify_timer_isolation'), \
                patch.object(r,'verify_backup_recovery',return_value={'proofSha256':'a'*64}), \
                patch.object(r,'once',side_effect=lambda n,req,action:action()), \
                patch.object(r.timers,'restore',return_value={'state':'ACTIVATION_RETURNED_REQUIRES_READBACK','timers':list(r.timers.TIMERS)}):
            self.assertEqual(r.restore_canary_timers(manifest,Mock(),Path('/isolated'))['state'],'ACTIVATION_RETURNED_REQUIRES_READBACK')


if __name__=='__main__':unittest.main()
