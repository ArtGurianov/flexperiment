import copy
import contextlib
import io
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid
from unittest.mock import Mock
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('fast_cut',ROOT/'scripts/v2/fast-cut.py')
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)

class FastCut(unittest.TestCase):
    def test_control_room_ingress_requires_exact_private_receipt_and_requalification(self):
        canary = 'flexperiment-fast-cut-canary'
        ingress = 'flexperiment-control-room-ingress'
        admin = {'Id': 'admin-id', 'NetworkSettings': {'Networks': {
            canary: {'IPAddress': '10.0.5.3'}, ingress: {'IPAddress': '10.0.6.3'}}}}
        commerce = {'Id': 'commerce-id', 'NetworkSettings': {'Networks': {canary: {'IPAddress': '10.0.5.2'}}},
                    'Config': {'Env': ['CONTROL_ROOM_TRUSTED_PROXY_IPS=10.0.5.3']}}
        proxy = {'Id': 'proxy-id', 'NetworkSettings': {'Networks': {ingress: {'IPAddress': '10.0.6.2'}}}}
        network = {'Id': 'network-id', 'Containers': {'admin-id': {}, 'proxy-id': {}}}
        receipt = {'schema': 'flexperiment.control-room-network/1', 'networkId': 'network-id',
                   'adminContainerId': 'admin-id', 'commerceContainerId': 'commerce-id',
                   'traefikContainerId': 'proxy-id', 'adminCanaryIp': '10.0.5.3',
                   'adminIngressIp': '10.0.6.3', 'traefikIngressIp': '10.0.6.2'}
        with tempfile.TemporaryDirectory() as directory, patch.object(f, 'INPUT', Path(directory)):
            with self.assertRaisesRegex(ValueError, 'RUNTIME_SCOPE'):
                f.assert_runtime_networks('admin', admin)
            (Path(directory)/'control-room-network.json').write_text('private fixture')
            def check(a=admin, c=commerce, p=proxy, n=network, r=receipt):
                with patch.object(f, 'private', return_value=json.dumps(r).encode()), \
                     patch.object(f, 'run', side_effect=[json.dumps([n]).encode(), json.dumps([c, p]).encode()]):
                    f.assert_runtime_networks('admin', a)
            check()
            mutations = [
                {'a': {**admin, 'Id': 'recreated-admin'}},
                {'c': {**commerce, 'Id': 'recreated-commerce'}},
                {'p': {**proxy, 'Id': 'recreated-proxy'}},
                {'n': {**network, 'Id': 'recreated-network'}},
                {'n': {**network, 'Containers': {**network['Containers'], 'intruder': {}}}},
                {'c': {**commerce, 'Config': {'Env': ['CONTROL_ROOM_TRUSTED_PROXY_IPS=10.0.5.0/24']}}},
                {'c': {**commerce, 'NetworkSettings': {'Networks': {canary: {}, ingress: {}}}}},
                {'p': {**proxy, 'NetworkSettings': {'Networks': {**proxy['NetworkSettings']['Networks'], canary: {}}}}},
                {'r': {**receipt, 'adminCanaryIp': '10.0.5.99'}},
                {'r': {**receipt, 'adminIngressIp': '10.0.6.99'}},
                {'r': {**receipt, 'traefikIngressIp': '10.0.6.99'}},
                {'r': {**receipt, 'unreviewed': True}},
            ]
            for mutation in mutations:
                with self.subTest(mutation=mutation), self.assertRaises(ValueError): check(**mutation)
            with patch.object(f, 'private', side_effect=ValueError('PRIVATE_CUSTODY')), \
                 self.assertRaisesRegex(ValueError, 'PRIVATE_CUSTODY'):
                f.assert_runtime_networks('admin', admin)
            for role in ['commerce', 'platform']:
                with self.subTest(role=role), self.assertRaisesRegex(ValueError, 'RUNTIME_SCOPE'):
                    f.assert_runtime_networks(role, admin)

    def setUp(self):
        f.release.cache_clear()
        f.paid_test.cache_clear()

    def tearDown(self):
        f.release.cache_clear()
        f.paid_test.cache_clear()

    def paid_candidate(self):
        return {'schema':'flexperiment.closed-paid-test/1','profile':'art39-test-course-rub1-v1',
                'courseRef':'test-course','offerRef':'course:test-course','amountKopecks':100,
                'buyerEmailSha256':'a'*64,'refrefSourceCommit':'b'*40,'legalVersion':'synthetic-paid',
                'legalManifestSha256':'c'*64}

    def test_paid_profile_is_explicit_exact_private_and_pinned_per_process(self):
        candidate=self.paid_candidate()
        self.assertEqual(f.validate_paid_test(candidate),candidate)
        for mutation in [{'courseRef':'other'},{'offerRef':'other'},{'amountKopecks':101},{'amountKopecks':True},
                         {'buyerEmailSha256':'x'},{'refrefSourceCommit':'main'},{'legalManifestSha256':''},{'unknown':True}]:
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):f.validate_paid_test({**candidate,**mutation})
        with tempfile.TemporaryDirectory() as d,patch.object(f,'INPUT',Path(d)):
            self.assertIsNone(f.paid_test());f.paid_test.cache_clear()
            path=Path(d)/'paid-test.json';path.write_text('placeholder')
            with patch.object(f,'private',return_value=json.dumps(candidate).encode()) as read:
                first=f.paid_test();self.assertIs(f.paid_test(),first);read.assert_called_once_with(path)
            f.paid_test.cache_clear()
            with patch.object(f,'private',side_effect=ValueError('PRIVATE_CUSTODY')),self.assertRaisesRegex(ValueError,'PRIVATE_CUSTODY'):f.paid_test()
            f.paid_test.cache_clear()
            with patch.object(f,'private',return_value=b'{"schema":1,"schema":2}'),self.assertRaises(ValueError):f.paid_test()

    def test_paid_environment_cannot_be_a_bare_flip_or_leak_keys_to_platform(self):
        p=self.paid_candidate()
        env={**f.ORIGINS,'PAYMENT_MODE':'refref','DEPLOY_ENV':'staging','MARKETING_BROADCASTS_ENABLED':'false',
             'CLOSED_PAID_TEST_PROFILE':p['profile'],'CLOSED_PAID_TEST_REFREF_SOURCE':p['refrefSourceCommit'],
             'CLOSED_PAID_TEST_LEGAL_VERSION':p['legalVersion'],'CLOSED_PAID_TEST_LEGAL_SHA256':p['legalManifestSha256'],
             'REFREF_API_BASE_URL':'https://api.refref.ru/v1-rc','REFREF_CHECKOUT_ORIGIN':'https://checkout.refref.ru',
             'REFREF_READINESS_URL':'https://ops.refref.ru/readyz'}
        f.assert_payment_environment(env,'platform',p)
        with self.assertRaises(ValueError):f.assert_payment_environment(env,'platform',None)
        for field in ['REFREF_API_KEY','REFREF_HANDOFF_STATE_SECRET','REFUND_ENVELOPE_KEYS','CLOSED_PAID_TEST_BUYER_SHA256']:
            with self.subTest(field=field),self.assertRaises(ValueError):f.assert_payment_environment({**env,field:'synthetic'},'platform',p)
        commerce={**env,'CLOSED_PAID_TEST_BUYER_SHA256':p['buyerEmailSha256'],'KINESCOPE_DELIVERY_MODE':'protected',
                  'COMMERCE_V2_ENVIRONMENT':'canary','ERASURE_SCOPE':'canary','ERASURE_FENCING_ENABLED':'true',
                  **{key:'synthetic' for key in ['REFREF_API_KEY','REFREF_MERCHANT_ID','REFREF_MERCHANT_SLUG',
                    'REFREF_HANDOFF_STATE_SECRET','REFUND_ENVELOPE_KEYS','REFUND_ENVELOPE_CURRENT_KEY']}}
        f.assert_payment_environment(commerce,'commerce',p)
        for mutation in [{'CLOSED_PAID_TEST_BUYER_SHA256':'d'*64},{'REFREF_READINESS_URL':'https://canary-ops.refref.ru/readyz'},
                         {'ERASURE_FENCING_ENABLED':'false'},{'REFREF_API_KEY':''},{'KINESCOPE_DELIVERY_MODE':'open'}]:
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):f.assert_payment_environment({**commerce,**mutation},'commerce',p)

    def candidate(self):
        return json.loads((ROOT/'deploy/v2/fast-cut/closed-e2e-release.json').read_bytes())

    def commerce_candidate(self):
        return json.loads((ROOT/'deploy/v2/fast-cut/art-351-commerce-release.json').read_bytes())

    def test_release_legacy_default_and_exact_new_role_vector(self):
        with tempfile.TemporaryDirectory() as d, patch.object(f,'INPUT',Path(d)):
            self.assertEqual(f.release(),{role:{'sourceCommit':f.SOURCE,'imageReference':image} for role,image in f.LEGACY_IMAGES.items()})
        old=json.loads((ROOT/'deploy/v2/fast-cut/compose.json').read_bytes())
        self.assertEqual(f.LEGACY_IMAGES,{role:row['image'] for role,row in old['services'].items()})
        new=f.validate_release(self.candidate())
        self.assertEqual(new['commerce']['sourceCommit'],new['platform']['sourceCommit'])
        self.assertNotEqual(new['commerce']['sourceCommit'],new['admin']['sourceCommit'])
        self.assertEqual(new['admin']['sourceCommit'],f.SOURCE)

    def test_commerce_only_vector_retains_platform_and_admin_artifacts(self):
        previous=f.validate_release(self.candidate())
        candidate=f.validate_release(self.commerce_candidate())
        self.assertNotEqual(candidate['commerce'],previous['commerce'])
        self.assertNotEqual(candidate['commerce']['sourceCommit'],candidate['platform']['sourceCommit'])
        self.assertEqual(candidate['platform'],previous['platform'])
        self.assertEqual(candidate['admin'],previous['admin'])

    def test_release_refuses_unknown_fields_scope_mutable_tag_role_swap_or_invalid_source(self):
        mutations=[lambda x:x.update(scope='production'),lambda x:x.update(unknown=True),
                   lambda x:x['roles'].pop('admin'),lambda x:x['roles'].update(worker=x['roles']['commerce']),
                   lambda x:x['roles']['platform'].update(sourceCommit='a'*39),
                   lambda x:x['roles']['commerce'].update(sourceCommit='main'),
                   lambda x:x['roles']['commerce'].update(imageReference='ghcr.io/artgurianov/flexperiment-commerce-v2:latest'),
                   lambda x:x['roles']['commerce'].update(imageReference=x['roles']['platform']['imageReference']),
                   lambda x:x['roles']['admin'].update(fence='OPEN')]
        for mutate in mutations:
            with self.subTest(mutate=mutate),self.assertRaises(ValueError):
                candidate=self.candidate();mutate(candidate);f.validate_release(candidate)

    def test_installed_release_uses_private_custody_and_pins_one_cli_vector(self):
        with tempfile.TemporaryDirectory() as d,patch.object(f,'INPUT',Path(d)):
            file=Path(d)/'release.json';file.write_text('placeholder')
            with patch.object(f,'private',return_value=json.dumps(self.candidate()).encode()) as read:
                first=f.release()
                self.assertIs(f.release(),first);read.assert_called_once_with(file)
            f.release.cache_clear()
            with patch.object(f,'private',side_effect=ValueError('FAST_CUT_PRIVATE_CUSTODY')),self.assertRaisesRegex(ValueError,'PRIVATE_CUSTODY'):
                f.release()

    def test_present_invalid_or_duplicate_release_never_falls_back_to_legacy(self):
        with tempfile.TemporaryDirectory() as d,patch.object(f,'INPUT',Path(d)):
            file=Path(d)/'release.json';file.write_text('placeholder')
            for raw in [b'{}',b'not json',b'{"scope":"production","scope":"canary"}']:
                f.release.cache_clear()
                with self.subTest(raw=raw),patch.object(f,'private',return_value=raw),self.assertRaises(ValueError):f.release()
            file.write_bytes(b'x'*4097);f.release.cache_clear()
            with patch.object(f,'private') as read,self.assertRaisesRegex(ValueError,'RELEASE_INVALID'):f.release()
            read.assert_not_called()

    def test_manifest_has_no_public_ports_or_payload_and_preserves_erasure_authority(self):
        v=json.loads((ROOT/'deploy/v2/fast-cut/compose.json').read_bytes())
        self.assertEqual(set(v['services']),{'commerce','platform','admin'})
        for service in v['services'].values():
            self.assertRegex(service['image'],r'^ghcr.io/artgurianov/flexperiment-(commerce|platform|admin)-v2@sha256:[a-f0-9]{64}$')
            self.assertNotIn('ports',service);self.assertNotIn('build',service)
            self.assertTrue(service['read_only'])
        mounts=v['services']['commerce']['volumes'];authority=[m for m in mounts if isinstance(m,dict)]
        self.assertEqual(len(authority),7)
        self.assertEqual([m['source'] for m in authority if not m['read_only']],['/var/lib/flexperiment-erasure-canary/fence'])
        # ART-319: the owner's storefront switch reaches Commerce read-only, never created by Docker.
        switch=[m for m in authority if m['target'] in ('/etc/flexperiment-sales','/etc/flexperiment-sales-journal')]
        self.assertEqual([(m['source'],m['read_only']) for m in switch],[('/var/lib/flexperiment-sales-canary/switch',True),
                                                                         ('/var/lib/flexperiment-sales-canary/journal',True)])
        self.assertTrue(all(not m['bind']['create_host_path'] for m in authority))
        self.assertEqual(v['services']['commerce']['networks']['canary']['aliases'],[f.ORIGINAL])
        self.assertNotIn('volumes',v['services']['platform'])

    def test_real_compose_raw_parser_preserves_dollars_quotes_unicode_without_shell_evaluation(self):
        values={'PASSWORD':'$demo ${DO_NOT_INTERPOLATE} "quotes" `literal` $(literal)', 'NAME':'тест value'}
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);(p/'input.env').write_bytes(f.raw_env(values))
            manifest={'services':{'probe':{'image':'busybox:1.37','env_file':[{'path':str(p/'input.env'),'format':'raw'}]}}}
            (p/'compose.json').write_text(json.dumps(manifest))
            cmd=['docker','compose','-p','art337-env-'+uuid.uuid4().hex,'-f',str(p/'compose.json')]
            # `config` escapes dollars for re-serializable YAML/JSON. Verify the
            # actual process environment, not that intentionally escaped form.
            try:
                result=subprocess.run(cmd+['run','--rm','-T','probe','env'],capture_output=True,text=True,timeout=90)
                self.assertEqual(result.returncode,0,result.stderr)
                actual=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
                self.assertEqual({key:actual[key] for key in values},values)
            finally:subprocess.run(cmd+['down','--remove-orphans'],capture_output=True,timeout=30)

    def test_env_newline_and_invalid_key_are_rejected(self):
        for value in [{'BAD-KEY':'x'},{'SECRET':'x\ny'},{'SECRET':'x\0y'},{'SECRET':None}]:
            with self.subTest(value=value),self.assertRaisesRegex(ValueError,'ENV_INVALID'):f.raw_env(value)

    def test_backup_stale_failed_future_traversal_or_changed_bytes_refuse(self):
        body=b'encrypted fixture';import hashlib
        good={'status':'SUCCESS','sourceCommit':f.SOURCE,'verifiedAt':int(time.time()),
              'filename':'fast-cut-20261014T000000Z-'+'a'*8+'-'+('a'*4+'-')*3+'a'*12+'.sqlite.age','sha256':hashlib.sha256(body).hexdigest(),'size':len(body)}
        def check(status,archive=body):
            with patch.object(f,'private',side_effect=[json.dumps(status).encode(),archive]):return f.check_backup()
        self.assertEqual(check(good)['status'],'FRESH')
        for change in [{'status':'FAILED'},{'verifiedAt':0},{'verifiedAt':int(time.time())+1000},{'filename':'../other'},{'sourceCommit':'b'*40}]:
            with self.subTest(change=change),self.assertRaises(ValueError):check({**good,**change})
        with self.assertRaisesRegex(ValueError,'BACKUP_CHANGED'):check(good,b'different')

    def test_readback_rejects_published_port_wrong_network_and_mutated_image(self):
        manifest=json.loads((ROOT/'deploy/v2/fast-cut/compose.json').read_bytes());s=manifest['services']['platform'];identity={'schema':'flexperiment.build-identity/1','service':'platform','sourceCommit':f.SOURCE}
        config={'Image':s['image'],'Env':['SOURCE_COMMIT='+f.SOURCE,'PLATFORM_V2_CANARY=true','PLATFORM_EXPECTED_COMMERCE_SHA='+f.SOURCE,'PAYMENT_MODE=disabled'],
                'Labels':{'com.flexperiment.scope':'canary-fast-cut'},'User':'node','Entrypoint':None,'Cmd':['node'],'WorkingDir':'/app'}
        c={'Config':config,'Image':'sha256:'+'a'*64,'HostConfig':{'PortBindings':{},'ReadonlyRootfs':True},'State':{'Running':True},
           'NetworkSettings':{'Networks':{'flexperiment-fast-cut-canary':{}}},'Mounts':[{'Type':'tmpfs','Destination':'/tmp'}]}
        image={'Id':c['Image'],'RootFS':{'Layers':['layer']},'Config':config,'Os':'linux','Architecture':'amd64'}
        qualified={'imageId':c['Image'],'rootfs':['layer'],'identity':identity}
        def check(container):
            with patch.object(f,'STACK',ROOT/'deploy/v2/fast-cut/compose.json'),patch.object(f,'private',return_value=json.dumps(qualified).encode()), \
                 patch.object(f,'run',side_effect=[json.dumps([container]).encode(),json.dumps([image]).encode(),json.dumps(identity).encode()]):return f.inspect('platform')
        self.assertEqual(check(c)[0],s['container_name'])
        image['Config']=copy.deepcopy(config);image['Config']['User']=None
        default=copy.deepcopy(c);default['Config']['User']=''
        self.assertEqual(check(default)[0],s['container_name'])
        wrong=copy.deepcopy(default);wrong['Config']['User']='1001'
        with self.assertRaisesRegex(ValueError,'EXECUTION_OVERRIDE'):check(wrong)
        image['Config']=config
        for mutate in [lambda x:x['HostConfig'].update(PortBindings={'80/tcp':[{}]}),lambda x:x['NetworkSettings']['Networks'].update(coolify={}),
                       lambda x:x.update(Image='different'),lambda x:x['Config']['Env'].append('PAYLOAD_SECRET=forbidden')]:
            bad=copy.deepcopy(c);mutate(bad)
            with self.assertRaises(ValueError):check(bad)

    def test_new_platform_requires_vector_image_native_source_env_and_expected_commerce(self):
        vector=f.validate_release(self.commerce_candidate());row=vector['platform']
        manifest=json.loads((ROOT/'deploy/v2/fast-cut/compose.json').read_bytes())
        manifest['services']['platform']['image']=row['imageReference']
        s=manifest['services']['platform'];identity={'schema':'flexperiment.build-identity/1','service':'platform','sourceCommit':row['sourceCommit']}
        config={'Image':s['image'],'Env':['SOURCE_COMMIT='+row['sourceCommit'],'PLATFORM_V2_CANARY=true','PLATFORM_EXPECTED_COMMERCE_SHA='+vector['commerce']['sourceCommit'],'PAYMENT_MODE=disabled'],
                'Labels':{'com.flexperiment.scope':'canary-fast-cut'},'User':'node','Entrypoint':None,'Cmd':['node'],'WorkingDir':'/app'}
        container={'Config':config,'Image':'sha256:'+'a'*64,'HostConfig':{'PortBindings':{},'ReadonlyRootfs':True},'State':{'Running':True},
                   'NetworkSettings':{'Networks':{'flexperiment-fast-cut-canary':{}}},'Mounts':[]}
        image={'Id':container['Image'],'RootFS':{'Layers':['layer']},'Config':copy.deepcopy(config),'Os':'linux','Architecture':'amd64'}
        qualified={'imageId':image['Id'],'rootfs':['layer'],'identity':identity}
        with tempfile.TemporaryDirectory() as d:
            stack=Path(d)/'compose.json';stack.write_text(json.dumps(manifest))
            def check(c,native=identity):
                with patch.object(f,'STACK',stack),patch.object(f,'release',return_value=vector),patch.object(f,'private',return_value=json.dumps(qualified).encode()), \
                     patch.object(f,'run',side_effect=[json.dumps([c]).encode(),json.dumps([image]).encode(),json.dumps(native).encode()]):return f.inspect('platform')
            self.assertEqual(check(container)[1]['identity'],identity)
            for mutate in [lambda c:c['Config']['Env'].append('SOURCE_COMMIT='+f.SOURCE),
                           lambda c:c['Config']['Env'].append('PLATFORM_EXPECTED_COMMERCE_SHA='+row['sourceCommit'])]:
                bad=copy.deepcopy(container);mutate(bad)
                with self.assertRaises(ValueError):check(bad)
            with self.assertRaises(ValueError):check(container,{**identity,'sourceCommit':f.SOURCE})
            manifest['services']['platform']['image']=f.LEGACY_IMAGES['platform'];stack.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError,'RELEASE_IMAGE_MISMATCH'):check(container)

    def test_mixed_release_admin_readiness_identifies_commerce_not_native_admin(self):
        vector=f.validate_release(self.commerce_candidate());target=vector['commerce']['sourceCommit']
        def connection(fence=False):
            db=Mock()
            def execute(query):
                result=Mock()
                if 'sqlite_master' in query:result.__iter__=Mock(return_value=iter([]))
                elif 'foreign_key_check' in query:result.fetchall.return_value=[]
                elif 'fence_state' in query:result.fetchone.return_value=('canary','OPEN',1,None)
                elif 'fence_leases' in query:result.fetchone.return_value=(0,)
                elif 'integrity_check' in query:result.fetchone.return_value=('ok',)
                else:result.fetchone.return_value=(28,)
                return result
            db.execute.side_effect=execute;return db
        def check(admin_source,platform_source=vector['platform']['sourceCommit']):
            ready=[{'ok':True,'foundationMode':False,'capabilities':{'erasure':'qualified'},'core':{'paymentMode':'disabled'},'sourceCommit':target},
                   {'status':200,'body':json.dumps({'sourceCommit':platform_source})},{'ok':True,'service':'commerce-v2','sourceCommit':admin_source},{'state':'REMOTE_VERIFIED','scope':'canary','sequence':1}]
            with patch.object(f,'release',return_value=vector),patch.object(f,'inspect',side_effect=lambda role:(role,{})), \
                 patch.object(f,'run',side_effect=[json.dumps(r).encode() for r in ready]), \
                 patch.object(f.sqlite3,'connect',side_effect=[connection(),connection(True)]), \
                 patch.object(f,'SCHEMA',__import__('hashlib').sha256(b'[]').hexdigest()),patch.object(f,'READINESS_ATTEMPTS',1):return f.check()
        self.assertEqual(check(target)['sourceCommit'],target)
        with self.assertRaisesRegex(ValueError,'ADMIN_NOT_READY'):check(f.SOURCE)
        with self.assertRaisesRegex(ValueError,'PLATFORM_NOT_READY'):check(target,platform_source=target)

    def test_readiness_timeouts_widen_outward_across_every_layer(self):
        import re
        services=json.loads((ROOT/'deploy/v2/fast-cut/compose.json').read_bytes())['services']
        def seconds(value):return int(value.rstrip('s'))
        def health(role):return services[role]['healthcheck']
        def abort_ms(text):return int(re.search(r'AbortSignal\.timeout\((\d+)\)',text).group(1))
        commerce_curl=health('commerce')['test'];budget=int(commerce_curl[commerce_curl.index('--max-time')+1])
        source=(ROOT/'apps/platform/lib/canary-readiness.ts').read_text()
        platform_wait=int(re.search(r'COMMERCE_READINESS_TIMEOUT_MS = ([\d_]+);',source).group(1).replace('_',''))
        nginx_wait=seconds(re.search(r'proxy_read_timeout (\d+s);',(ROOT/'deploy/v2/frontends/proxy.conf').read_text()).group(1))
        admin_wget=health('admin')['test'];admin_health=int(admin_wget[admin_wget.index('-T')+1])
        commerce=(ROOT/'commerce-v2/src/readiness.ts').read_text()
        deadline=int(re.search(r'READINESS_DEADLINE_MS = ([\d_]+);',commerce).group(1).replace('_',''))
        # Commerce enforces its own deadline (fresh authority read included); every client waits longer.
        self.assertLess(deadline,budget*1000)
        self.assertEqual(f.READINESS_TIMEOUT['commerce'],budget)
        self.assertGreater(seconds(health('commerce')['timeout']),budget)
        # Each wrapper waits at least as long as what it wraps, then strictly longer outward.
        self.assertEqual(platform_wait,budget*1000)
        self.assertGreaterEqual(nginx_wait,budget)
        self.assertGreater(abort_ms(health('platform')['test'][-1]),platform_wait)
        self.assertGreater(seconds(health('platform')['timeout'])*1000,abort_ms(health('platform')['test'][-1]))
        self.assertGreater(f.READINESS_TIMEOUT['platform']*1000,platform_wait)
        self.assertGreater(admin_health,nginx_wait)
        self.assertGreater(seconds(health('admin')['timeout']),admin_health)
        self.assertGreater(f.READINESS_TIMEOUT['admin'],nginx_wait)
        self.assertGreater(f.READINESS_COMMAND_TIMEOUT,max(f.READINESS_TIMEOUT.values()))

    def test_readiness_probes_carry_their_own_bounded_wait(self):
        vector=f.validate_release(self.commerce_candidate());target=vector['commerce']['sourceCommit'];calls=[]
        ready={'commerce':{'ok':True,'foundationMode':False,'capabilities':{'erasure':'qualified'},'core':{'paymentMode':'disabled'},'sourceCommit':target},
               'platform':{'status':200,'body':json.dumps({'sourceCommit':vector['platform']['sourceCommit']})},'admin':{'ok':True,'service':'commerce-v2','sourceCommit':target}}
        def command(args,timeout=180,**kwargs):
            calls.append((args,timeout))
            return json.dumps(ready[['commerce','platform','admin'][len(calls)-1]]).encode()
        with patch.object(f,'release',return_value=vector),patch.object(f,'inspect',side_effect=lambda role:(role,{})), \
             patch.object(f,'run',side_effect=command),patch.object(f,'DATABASE',Path('/nonexistent/commerce.sqlite')), \
             self.assertRaises(f.sqlite3.OperationalError):f.check()
        (commerce,c_timeout),(platform,p_timeout),(admin,a_timeout)=calls[:3]
        self.assertEqual(commerce[commerce.index('--max-time')+1],str(f.READINESS_TIMEOUT['commerce']))
        self.assertIn('AbortSignal.timeout(%d)'%(f.READINESS_TIMEOUT['platform']*1000),platform[-1])
        self.assertEqual(admin[admin.index('-T')+1],str(f.READINESS_TIMEOUT['admin']))
        self.assertEqual({c_timeout,p_timeout,a_timeout},{f.READINESS_COMMAND_TIMEOUT})

    def test_platform_readiness_refusal_reports_only_allowlisted_detail(self):
        vector=f.validate_release(self.commerce_candidate());target=vector['commerce']['sourceCommit']
        secret='synthetic-private-value@example.invalid/token'
        commerce={'ok':True,'foundationMode':False,'capabilities':{'erasure':'qualified'},'core':{'paymentMode':'disabled'},'sourceCommit':target}
        refused=lambda reason:json.dumps({'ok':False,'service':'platform','error':'PLATFORM_NOT_READY','reason':reason,'elapsedMs':10001})
        cases=[({'status':503,'body':refused('UPSTREAM_TIMEOUT')},'UPSTREAM_TIMEOUT',503),
               ({'status':503,'body':refused('UPSTREAM_CONTRACT')},'UPSTREAM_CONTRACT',503),
               ({'status':503,'body':refused(secret)},None,503),
               ({'status':502,'body':secret},None,502),
               ({'status':secret,'body':secret},None,None),
               ({'error':'TIMEOUT'},'PROBE_TIMEOUT',None),
               ({'error':'TRANSPORT'},'PROBE_TRANSPORT',None),
               ({'error':secret},None,None)]
        for envelope,detail,status in cases:
            with self.subTest(envelope=envelope):
                output=io.StringIO()
                with patch.object(f,'release',return_value=vector),patch.object(f,'inspect',side_effect=lambda role:(role,{})), \
                     patch.object(f,'run',side_effect=[json.dumps(commerce).encode(),json.dumps(envelope).encode()]), \
                     patch.object(f,'READINESS_ATTEMPTS',1),contextlib.redirect_stdout(output):
                    self.assertEqual(f.main(['check']),1)
                raw=output.getvalue();self.assertNotIn(secret,raw);report=json.loads(raw)
                self.assertEqual(report['stage'],'platform_readiness');self.assertEqual(report['code'],'FAST_CUT_PLATFORM_NOT_READY')
                self.assertEqual(report.get('detail'),detail);self.assertEqual(report.get('httpStatus'),status)

    def test_commerce_probe_exit_code_maps_to_fixed_detail(self):
        vector=f.validate_release(self.commerce_candidate());secret='synthetic-private-value@example.invalid/token'
        for rc,detail in [(28,'PROBE_TIMEOUT'),(7,'PROBE_TRANSPORT'),(22,'HTTP_STATUS'),(99,None)]:
            with self.subTest(rc=rc):
                output=io.StringIO()
                completed=subprocess.CompletedProcess(['curl'],rc,stdout=secret.encode())
                with patch.object(f,'release',return_value=vector),patch.object(f,'inspect',side_effect=lambda role:(role,{})), \
                     patch.object(f.subprocess,'run',return_value=completed),patch.object(f,'READINESS_ATTEMPTS',1), \
                     contextlib.redirect_stdout(output):
                    self.assertEqual(f.main(['check']),1)
                raw=output.getvalue();self.assertNotIn(secret,raw);report=json.loads(raw)
                self.assertEqual((report['stage'],report['code']),('commerce_readiness','FAST_CUT_COMMAND_FAILED'))
                self.assertEqual(report.get('detail'),detail)

    def readiness_fixture(self,platform_probes,inspect=None):
        """check() against synthetic runtimes; Platform answers from platform_probes in order."""
        vector=f.validate_release(self.commerce_candidate());target=vector['commerce']['sourceCommit']
        commerce={'ok':True,'foundationMode':False,'capabilities':{'erasure':'qualified'},'core':{'paymentMode':'disabled'},'sourceCommit':target}
        admin={'ok':True,'service':'commerce-v2','sourceCommit':target};probes=iter(platform_probes)
        def command(args,**kwargs):
            if args[:2]==['/usr/local/bin/flexperiment-erasure','read']:return json.dumps({'state':'REMOTE_VERIFIED','scope':'canary','sequence':1}).encode()
            role=args[2]
            if role=='platform':return json.dumps(next(probes)).encode()
            return json.dumps(commerce if role=='commerce' else admin).encode()
        def connection(*args,**kwargs):
            db=Mock()
            def execute(query):
                result=Mock()
                if 'sqlite_master' in query:result.__iter__=Mock(return_value=iter([]))
                elif 'foreign_key_check' in query:result.fetchall.return_value=[]
                elif 'fence_state' in query:result.fetchone.return_value=('canary','OPEN',1,None)
                elif 'fence_leases' in query:result.fetchone.return_value=(0,)
                elif 'integrity_check' in query:result.fetchone.return_value=('ok',)
                else:result.fetchone.return_value=(28,)
                return result
            db.execute.side_effect=execute;return db
        return contextlib.ExitStack(),[
            patch.object(f,'release',return_value=vector),
            patch.object(f,'inspect',side_effect=inspect or (lambda role:(role,{}))),
            patch.object(f,'run',side_effect=command),patch.object(f.sqlite3,'connect',side_effect=connection),
            patch.object(f,'SCHEMA',__import__('hashlib').sha256(b'[]').hexdigest()),
            patch.object(f.time,'sleep')],vector

    def test_one_slow_platform_readiness_is_retried_after_a_bounded_pause(self):
        secret='synthetic-private-value@example.invalid/token'
        refused={'status':503,'body':json.dumps({'ok':False,'error':'PLATFORM_NOT_READY','reason':'UPSTREAM_TIMEOUT','note':secret})}
        platform=f.validate_release(self.commerce_candidate())['platform']['sourceCommit']
        stack,patches,_=self.readiness_fixture([refused,{'status':200,'body':json.dumps({'sourceCommit':platform})}])
        errors=io.StringIO()
        with stack:
            mocks=[stack.enter_context(p) for p in patches];sleep=mocks[-1]
            with contextlib.redirect_stderr(errors):result=f.check()
        self.assertEqual(result['state'],'RUNTIME_CHECK_PASS_NOT_FINAL_ACCEPTANCE')
        sleep.assert_called_once_with(f.READINESS_RETRY_PAUSE)
        self.assertNotIn(secret,errors.getvalue())
        retry=json.loads(errors.getvalue())
        self.assertEqual({k:retry[k] for k in ['state','stage','attempt','code','detail','httpStatus']},
                         {'state':'FAST_CUT_READINESS_RETRY','stage':'platform_readiness','attempt':1,
                          'code':'FAST_CUT_PLATFORM_NOT_READY','detail':'UPSTREAM_TIMEOUT','httpStatus':503})

    def test_persistent_readiness_refusal_holds_backup_after_bounded_attempts(self):
        refused={'status':503,'body':json.dumps({'reason':'UPSTREAM_TIMEOUT'})}
        stack,patches,_=self.readiness_fixture([refused]*f.READINESS_ATTEMPTS)
        output=io.StringIO();errors=io.StringIO()
        with stack:
            mocks=[stack.enter_context(p) for p in patches];sleep=mocks[-1];command=mocks[2]
            with patch.object(f,'transport') as transport,contextlib.redirect_stdout(output),contextlib.redirect_stderr(errors):
                self.assertEqual(f.main(['backup']),1)
        report=json.loads(output.getvalue())
        self.assertEqual((report['stage'],report['code'],report['detail']),('platform_readiness','FAST_CUT_PLATFORM_NOT_READY','UPSTREAM_TIMEOUT'))
        self.assertEqual(sleep.call_count,f.READINESS_ATTEMPTS-1)
        self.assertEqual(len(errors.getvalue().splitlines()),f.READINESS_ATTEMPTS-1)
        self.assertEqual([c.args[0][2] for c in command.call_args_list],['commerce']+['platform']*f.READINESS_ATTEMPTS)
        transport.assert_not_called()

    def test_identity_drift_is_never_retried(self):
        def drift(role):raise f.GuardRefusal('FAST_CUT_IMAGE_DRIFT')
        stack,patches,_=self.readiness_fixture([],inspect=drift)
        with stack:
            mocks=[stack.enter_context(p) for p in patches];sleep=mocks[-1];inspect=mocks[1]
            with self.assertRaisesRegex(ValueError,'IMAGE_DRIFT'):f.check()
        self.assertEqual(inspect.call_count,1);sleep.assert_not_called()

    def test_readiness_retries_fit_inside_the_backup_unit(self):
        import ast,inspect,re
        tree=ast.parse(Path(f.__file__).read_text())
        def function(name):return next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name==name)
        def runs(name):return [n for n in ast.walk(function(name)) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='run']
        default=inspect.signature(f.run).parameters['timeout'].default
        def timeout(call):return next((ast.literal_eval(k.value) for k in call.keywords if k.arg=='timeout'),default)
        # Three role inspections plus the post-check Commerce inspection; Admin
        # additionally checks the ingress network and the Commerce/proxy peers.
        identity=(4*len(runs('inspect'))+len(runs('assert_runtime_networks')))*default
        readiness=3*(f.READINESS_ATTEMPTS*f.READINESS_COMMAND_TIMEOUT+(f.READINESS_ATTEMPTS-1)*f.READINESS_RETRY_PAUSE)
        transport=ast.parse((ROOT/'scripts/v2/scheduled-backup.py').read_text())
        call=next(n for n in ast.walk(next(n for n in transport.body if isinstance(n,ast.FunctionDef) and n.name=='run'))
                  if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='run')
        transport_timeout=next(ast.literal_eval(k.value) for k in call.keywords if k.arg=='timeout')
        s3_calls=sum(isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='s3' for n in ast.walk(function('backup')))
        worst=identity+readiness+sum(timeout(c) for c in runs('check')+runs('backup'))+s3_calls*transport_timeout
        unit=(ROOT/'deploy/v2/fast-cut/backup.service').read_text()
        seconds=int(re.search(r'TimeoutStartSec=(\d+)min',unit).group(1))*60
        self.assertEqual(identity,14*180)
        self.assertEqual(worst,4440)  # 74 min of subprocess limits, not the previous 25 min estimate.
        self.assertGreaterEqual(seconds,worst+300)  # Additional local IO/scheduling allowance.
        self.assertLess(6*3600+seconds,8*3600)  # A full allowed run still fits the freshness window.

    def test_docker_exec_timeout_keeps_a_fixed_code_and_never_reaches_snapshot(self):
        vector=f.validate_release(self.commerce_candidate());out=io.StringIO()
        def command(*args,**kwargs):raise subprocess.TimeoutExpired(['docker','exec','SYNTHETIC_SECRET'],30)
        with patch.object(f,'release',return_value=vector),patch.object(f,'inspect',return_value=('commerce',{})), \
             patch.object(f.subprocess,'run',side_effect=command),patch.object(f.time,'sleep'),patch.object(f,'transport') as transport, \
             contextlib.redirect_stdout(out),contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(f.main(['backup']),1)
        report=json.loads(out.getvalue());self.assertEqual(report['code'],'FAST_CUT_COMMAND_TIMEOUT')
        self.assertEqual(report['stage'],'commerce_readiness');self.assertNotIn('SYNTHETIC_SECRET',out.getvalue())
        transport.assert_not_called()

    def test_actual_admin_nginx_readiness_has_new_upstream_source_and_retained_native_identity(self):
        target=self.candidate()['roles']['commerce']['sourceCommit']
        prefix='fast-cut-readiness-'+uuid.uuid4().hex[:12];network=prefix+'-net';upstream=prefix+'-upstream';admin=prefix+'-admin'
        def docker(*args):return subprocess.check_output(['docker',*args],stderr=subprocess.DEVNULL,timeout=60)
        with tempfile.TemporaryDirectory() as d:
            identity=Path(d)/'release.json';identity.write_text(json.dumps({'source_commit':f.SOURCE,'admin_contract_version':'synthetic'}))
            try:
                docker('network','create','--internal',network)
                code="require('node:http').createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({ok:true,service:'commerce-v2',sourceCommit:process.argv[1]}))}).listen(3002,'0.0.0.0')"
                # Only this readiness fixture doubles as the resolvable synthetic proxy peer.
                # The dedicated frontend suite exercises an actual Traefik chain.
                docker('run','-d','--name',upstream,'--network',network,'--network-alias',f.ORIGINAL,
                       '--network-alias','coolify-proxy','node:22-bookworm-slim','node','-e',code,target)
                docker('run','-d','--name',admin,'--network',network,'--read-only','--tmpfs','/var/cache/nginx','--tmpfs','/var/run','--tmpfs','/tmp',
                       '-v',str(ROOT/'deploy/v2/fast-cut/admin.conf')+':/etc/nginx/conf.d/default.conf:ro',
                       '-v',str(ROOT/'deploy/v2/fast-cut/admin-common.conf')+':/etc/nginx/fast-cut/admin-common.conf:ro',
                       '-v',str(ROOT/'deploy/v2/frontends')+':/etc/nginx/v2:ro',
                       '-v',str(identity)+':/usr/share/nginx/html/release.json:ro','nginx:1.29-alpine')
                for _ in range(30):
                    try:
                        ready=json.loads(docker('exec',admin,'wget','-qO-','http://127.0.0.1/readyz'));break
                    except subprocess.CalledProcessError:time.sleep(.1)
                else:self.fail('isolated Admin nginx did not become ready')
                self.assertEqual(ready,{'ok':True,'service':'commerce-v2','sourceCommit':target})
                native=json.loads(docker('exec',admin,'cat','/usr/share/nginx/html/release.json'))
                self.assertEqual(native['source_commit'],f.SOURCE)
                self.assertNotEqual(ready['sourceCommit'],native['source_commit'])
            finally:
                for name in [admin,upstream]:subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=30)
                subprocess.run(['docker','network','rm',network],capture_output=True,timeout=30)

    def test_backup_after_candidate_switch_rejects_previous_source_status(self):
        vector=f.validate_release(self.commerce_candidate());body=b'encrypted fixture';import hashlib
        status={'status':'SUCCESS','sourceCommit':vector['platform']['sourceCommit'],'verifiedAt':int(time.time()),
                'filename':'fast-cut-20261015T000000Z-'+str(uuid.uuid4())+'.sqlite.age','sha256':hashlib.sha256(body).hexdigest(),'size':len(body)}
        with patch.object(f,'release',return_value=vector):
            with patch.object(f,'private',return_value=json.dumps(status).encode()),self.assertRaisesRegex(ValueError,'BACKUP_STALE'):f.check_backup()
            status['sourceCommit']=vector['commerce']['sourceCommit']
            with patch.object(f,'private',side_effect=[json.dumps(status).encode(),body]):self.assertEqual(f.check_backup()['status'],'FRESH')

    def test_backup_new_source_filename_transport_status_and_freshness(self):
        vector=f.validate_release(self.commerce_candidate());target=vector['commerce']['sourceCommit'];body=b'encrypted archive fixture'
        import hashlib
        proof={'filename':'canary-'+target+'-'+str(uuid.uuid4())+'.sqlite.age','sha256':hashlib.sha256(body).hexdigest(),'size':len(body)}
        transport=Mock();transport.s3.side_effect=[b'',(proof['sha256']+'  archive').encode()]
        with tempfile.TemporaryDirectory() as d:
            backups=Path(d)/'backups'
            def command(args,**kwargs):
                if args[1]=='exec':return json.dumps(proof).encode()
                Path(args[-1]).write_bytes(body);return b''
            with patch.object(f,'release',return_value=vector),patch.object(f,'check'),patch.object(f,'inspect',return_value=('commerce',{})), \
                 patch.object(f,'run',side_effect=command),patch.object(f,'BACKUPS',backups),patch.object(f,'transport',return_value=transport), \
                 patch.object(f.os,'chown'),patch.object(f,'private',side_effect=lambda p:p.read_bytes()):
                status=f.backup()
                self.assertEqual(status['sourceCommit'],target)
                self.assertEqual(json.loads((backups/'status.json').read_text()),status)
                self.assertEqual(f.check_backup()['status'],'FRESH')
                self.assertEqual(transport.s3.call_count,2)
                proof['filename']='canary-'+f.SOURCE+'-'+str(uuid.uuid4())+'.sqlite.age'
                with self.assertRaisesRegex(ValueError,'BACKUP_IDENTITY'):f.backup()
                self.assertEqual(transport.s3.call_count,2)

    def test_cli_failure_report_never_reflects_error_commands_or_unknown_codes(self):
        secret='synthetic-private-value@example.invalid/token'
        class HostileError(Exception):
            def __str__(self):raise AssertionError('ERROR_MUST_NOT_BE_STRINGIFIED')
        errors=[(f.GuardRefusal('FAST_CUT_FENCE'),'GUARD_REFUSED','FAST_CUT_FENCE'),
                (f.GuardRefusal('FAST_CUT_'+secret),'UNKNOWN',None),
                (ValueError('FAST_CUT_FENCE '+secret),'UNKNOWN',None),
                (subprocess.TimeoutExpired(['curl',secret],9,output=secret.encode()),'TIMEOUT','FAST_CUT_COMMAND_TIMEOUT'),
                (PermissionError(secret),'PERMISSION',None),(FileNotFoundError(secret),'MISSING_FILE',None),
                (json.JSONDecodeError(secret,secret,0),'INVALID_JSON','FAST_CUT_INVALID_JSON'),(HostileError(),'UNKNOWN',None)]
        for error,reason,code in errors:
            with self.subTest(reason=reason,code=code):
                def refuse():
                    f.mark_stage('remote_ledger')
                    raise error
                output=io.StringIO()
                with patch.object(f,'check',side_effect=refuse),contextlib.redirect_stdout(output):
                    self.assertEqual(f.main(['check']),1)
                raw=output.getvalue();self.assertNotIn(secret,raw)
                result=json.loads(raw)
                self.assertEqual(result['state'],'FAST_CUT_HOLD');self.assertEqual(result['operation'],'check')
                self.assertEqual(result['stage'],'remote_ledger');self.assertEqual(result['reason'],reason)
                self.assertEqual(result.get('code'),code);self.assertGreaterEqual(result['elapsedMs'],0)
                self.assertRegex(result['observedAt'],r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')

    def test_failed_backup_stage_is_kept_without_retries_or_success_overwrite(self):
        vector=f.validate_release(self.commerce_candidate());target=vector['commerce']['sourceCommit']
        body=b'encrypted archive fixture';import hashlib
        proof={'filename':'canary-'+target+'-'+str(uuid.uuid4())+'.sqlite.age',
               'sha256':hashlib.sha256(body).hexdigest(),'size':len(body)}
        for stage in ['fence','snapshot','remote_upload','remote_readback']:
            with self.subTest(stage=stage),tempfile.TemporaryDirectory() as d:
                backups=Path(d);previous=b'{"status":"SUCCESS","historic":"keep exact bytes"}'
                (backups/'status.json').write_bytes(previous);transport=Mock();commands=[]
                def admission():
                    if stage=='fence':
                        f.mark_stage('fence');raise f.GuardRefusal('FAST_CUT_FENCE')
                def command(args,**kwargs):
                    commands.append(args[1])
                    if args[1]=='exec':
                        if stage=='snapshot':raise subprocess.TimeoutExpired(['SECRET'],900)
                        return json.dumps(proof).encode()
                    Path(args[-1]).write_bytes(body);return b''
                if stage=='remote_upload':transport.s3.side_effect=ValueError('SECRET_PROVIDER_BODY')
                else:transport.s3.side_effect=[b'',b'0'*64+b' archive']
                output=io.StringIO()
                with patch.object(f,'release',return_value=vector),patch.object(f,'check',side_effect=admission), \
                     patch.object(f,'inspect',return_value=('commerce',{})),patch.object(f,'run',side_effect=command), \
                     patch.object(f,'BACKUPS',backups),patch.object(f,'transport',return_value=transport), \
                     patch.object(f.os,'chown'),patch.object(f,'private',side_effect=lambda p:p.read_bytes()), \
                     contextlib.redirect_stdout(output):
                    self.assertEqual(f.main(['backup']),1)
                raw=output.getvalue();self.assertNotIn('SECRET',raw);report=json.loads(raw)
                self.assertEqual(report['stage'],stage)
                self.assertEqual((backups/'status.json').read_bytes(),previous)
                self.assertEqual(transport.s3.call_count,0 if stage in ['fence','snapshot'] else 1 if stage=='remote_upload' else 2)
                self.assertEqual(commands,[] if stage=='fence' else ['exec'] if stage=='snapshot' else ['exec','cp'])
                if stage=='remote_readback':self.assertEqual(report['code'],'FAST_CUT_REMOTE_BACKUP_HASH')

if __name__=='__main__':unittest.main()
