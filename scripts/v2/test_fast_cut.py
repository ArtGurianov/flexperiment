import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('fast_cut',ROOT/'scripts/v2/fast-cut.py')
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)

class FastCut(unittest.TestCase):
    def test_manifest_has_no_public_ports_or_payload_and_preserves_erasure_authority(self):
        v=json.loads((ROOT/'deploy/v2/fast-cut/compose.json').read_bytes())
        self.assertEqual(set(v['services']),{'commerce','platform','admin'})
        for service in v['services'].values():
            self.assertRegex(service['image'],r'^ghcr.io/artgurianov/flexperiment-(commerce|platform|admin)-v2@sha256:[a-f0-9]{64}$')
            self.assertNotIn('ports',service);self.assertNotIn('build',service)
            self.assertTrue(service['read_only'])
        mounts=v['services']['commerce']['volumes'];authority=[m for m in mounts if isinstance(m,dict)]
        self.assertEqual(len(authority),5)
        self.assertEqual([m['source'] for m in authority if not m['read_only']],['/var/lib/flexperiment-erasure-canary/fence'])
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
        config={'Image':s['image'],'Env':['PLATFORM_V2_CANARY=true','PLATFORM_EXPECTED_COMMERCE_SHA='+f.SOURCE],
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

if __name__=='__main__':unittest.main()
