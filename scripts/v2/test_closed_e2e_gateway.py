"""Real nginx/TLS boundaries on isolated fixtures; no VPS/provider or app E2E claim."""
import json
import hashlib
import os
import shutil
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
IMAGE = os.environ.get('V2_GATEWAY_TEST_IMAGE', 'nginx:1.27-alpine')
HOSTS = ['canary-'+s+'.flexperiment.ru' for s in ['api','platform','admin','lab']]
FIXTURE = """const http=require('node:http');
for(const port of [80,3001,3002])http.createServer((req,res)=>{
 let body='';req.on('data',v=>body+=v);req.on('end',()=>{
  const drm=req.url==='/v1/kinescope/drm/authorize';
  res.writeHead(drm?(req.headers.authorization?400:401):200,{'Content-Type':'application/json','Set-Cookie':'fixture=opaque; Path=/; Secure; HttpOnly; SameSite=Lax'});
  res.end(JSON.stringify({host:req.headers.host,path:req.url,scheme:req.headers['x-forwarded-proto'],cookie:!!req.headers.cookie,authorization:!!req.headers.authorization}));
 });
}).listen(port,'0.0.0.0');"""

def docker(*args):
    return subprocess.check_output(['docker',*args],stderr=subprocess.DEVNULL,timeout=60).decode().strip()

class ClosedGateway(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.prefix='art336-'+uuid.uuid4().hex[:12];cls.containers=[];cls.network=cls.prefix+'-net';cls.volume=cls.prefix+'-tls'
        cls.tmp=tempfile.TemporaryDirectory();cls.addClassCleanup(cls.cleanup);p=Path(cls.tmp.name)
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',str(p/'privkey.pem'),'-out',str(p/'fullchain.pem'),'-subj','/CN='+HOSTS[0],'-addext','subjectAltName='+','.join('DNS:'+h for h in HOSTS)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        docker('network','create',cls.network);docker('volume','create',cls.volume)
        # Root-owned600 key in a private fixture volume matches the actual nginx custody.
        docker('run','--rm','-v',str(p)+':/source:ro','-v',cls.volume+':/tls','--entrypoint','sh',IMAGE,'-c','cp /source/*.pem /tls/; chmod 600 /tls/privkey.pem; chmod 644 /tls/fullchain.pem')
        shutil.copytree(ROOT/'docs/legal/stage-a/2026-10-11-draft',p/'legal')
        shutil.copytree(ROOT/'docs/legal/closed-paid-test/2026-10-16-review-3',p/'legal/paid-test/2026-10-16-review-3')
        shutil.copytree(ROOT/'docs/legal/closed-paid-test/2026-10-16-review-4',p/'legal/paid-test/2026-10-16-review-4')
        upstream=cls.prefix+'-upstream';cls.containers.append(upstream)
        docker('run','-d','--name',upstream,'--network',cls.network,'--network-alias','flexperiment-fast-cut-canary-commerce','--network-alias','flexperiment-fast-cut-canary-platform','--network-alias','flexperiment-fast-cut-canary-admin','node:22-alpine','node','-e',FIXTURE)
        cls.urls={}
        for role,port in [('drm-bridge',80),('tester',443)]:
            name=cls.prefix+'-'+role;cls.containers.append(name)
            cmd=['run','-d','--name',name,'--network',cls.network,'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges']
            for cap in ['CHOWN','SETUID','SETGID','NET_BIND_SERVICE']:cmd+=['--cap-add',cap]
            for mount in ['/tmp','/var/cache/nginx','/var/run']:cmd+=['--tmpfs',mount]
            cmd+=['-v',str(ROOT/'deploy/v2/closed-e2e'/(role+'.conf'))+':/etc/nginx/conf.d/default.conf:ro','-p','127.0.0.1::'+str(port)]
            if role=='tester':cmd+=['-v',cls.volume+':/etc/canary-tls:ro','-v',str(p/'legal')+':/etc/canary-legal:ro']
            docker(*cmd,IMAGE)
            row=json.loads(docker('inspect',name))[0]
            if not row['State']['Running']:raise RuntimeError('NGINX_START_FAILED: '+docker('logs',name))
            bindings=row['NetworkSettings']['Ports'].get(str(port)+'/tcp') or row['HostConfig']['PortBindings'].get(str(port)+'/tcp')
            if not bindings or not bindings[0].get('HostPort'):raise RuntimeError('LOOPBACK_TEST_PORT_NOT_ASSIGNED')
            cls.urls[role]=int(bindings[0]['HostPort'])
        for _ in range(30):
            try:
                if (cls.request('drm-bridge','/healthz',HOSTS[0],host_override='localhost')[0]==200
                        and cls.request('tester','/fixture',HOSTS[1])[0]==200):break
            except subprocess.SubprocessError:pass
            time.sleep(.2)
        else:raise RuntimeError('FIXTURE_NOT_READY')

    @classmethod
    def cleanup(cls):
        for name in getattr(cls,'containers',[]):subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=30)
        for kind,name in [('network',getattr(cls,'network','')),('volume',getattr(cls,'volume',''))]:
            if name:subprocess.run(['docker',kind,'rm',name],capture_output=True,timeout=30)
        if hasattr(cls,'tmp'):cls.tmp.cleanup()

    @classmethod
    def request(cls,role,path,host,method='GET',body=None,headers=None,host_override=None):
        port=cls.urls[role];tls=role=='tester';url=('https' if tls else 'http')+'://'+host+':'+str(port)+path
        cmd=['curl','--silent','--show-error','--noproxy','*','--max-time','8','--resolve',host+':'+str(port)+':127.0.0.1','-X',method,'-D','-',url]
        if tls:cmd+=['--cacert',str(Path(cls.tmp.name)/'fullchain.pem')]
        if host_override:cmd+=['-H','Host: '+host_override]
        for key,value in (headers or {}).items():cmd+=['-H',key+': '+value]
        if body is not None:cmd+=['--data-binary','@-']
        out=subprocess.run(cmd,input=body,capture_output=True,timeout=12,check=True).stdout
        head,raw=out.split(b'\r\n\r\n',1);lines=head.decode().splitlines();return int(lines[0].split()[1]),dict(v.lower().split(': ',1) for v in lines[1:] if ': ' in v),raw

    def test_manifest_keeps_callback_bounded_and_tester_loopback_only(self):
        m=json.loads((ROOT/'deploy/v2/closed-e2e/compose.json').read_bytes());bridge=m['services']['drm-bridge'];tester=m['services']['tester']
        self.assertNotIn('ports',bridge);self.assertEqual(bridge['networks'],['private','callback']);self.assertEqual(tester['networks'],['private']);self.assertEqual(tester['ports'],['127.0.0.1:8446:443'])
        for row in m['services'].values():
            self.assertNotIn('env_file',row);self.assertNotIn('environment',row);self.assertNotIn('build',row);self.assertTrue(row['read_only']);self.assertRegex(row['image'],r'@sha256:[a-f0-9]{64}$');self.assertTrue(all(v['read_only'] for v in row['volumes']))

    def test_callback_exact_host_method_path_auth_body_cap_and_no_store(self):
        path='/v1/kinescope/drm/authorize'
        for host,method,p in [(HOSTS[1],'POST',path),(HOSTS[0],'GET',path),(HOSTS[0],'POST',path+'/extra'),(HOSTS[0],'POST','/v1/auth/sign-in/magic-link'),(HOSTS[0],'POST','/v1/webhooks/kinescope')]:
            self.assertEqual(self.request('drm-bridge',p,host,method,b'{}')[0],404)
        status,head,_=self.request('drm-bridge',path,HOSTS[0],'POST',b'{}');self.assertEqual(status,401);self.assertEqual(head['cache-control'],'no-store')
        status,_,raw=self.request('drm-bridge',path,HOSTS[0],'POST',b'{}',{'Authorization':'Basic Zml4dHVyZTpwYXNz'});self.assertEqual(status,400);self.assertTrue(json.loads(raw)['authorization'])
        self.assertEqual(self.request('drm-bridge',path,HOSTS[0],'POST',b'x'*16385)[0],413)

    def test_private_tls_preserves_host_scheme_cookie_and_rejects_unlisted_host(self):
        for host in HOSTS[:3]:
            status,headers,raw=self.request('tester','/fixture',host,headers={'Cookie':'fixture=opaque'})
            self.assertEqual(status,200);data=json.loads(raw);self.assertEqual(data['host'],host);self.assertEqual(data['scheme'],'https');self.assertTrue(data['cookie']);self.assertIn('secure',headers['set-cookie']);self.assertEqual(headers['cache-control'],'no-store')
        self.assertEqual(self.request('tester','/',HOSTS[3])[0],403)

    def test_approved_legal_bytes_are_platform_only_read_only_and_private(self):
        proposal=json.loads((ROOT/'docs/plans/2026-10-15-canary-legal-activation-proposal.json').read_bytes())
        for document in proposal['documents']:
            path='/__closed_legal/'+document['kind']+'.md'
            status,headers,raw=self.request('tester',path,HOSTS[1])
            self.assertEqual(status,200);self.assertEqual(headers['cache-control'],'no-store')
            self.assertEqual(hashlib.sha256(raw).hexdigest(),document['sha256'])
            self.assertEqual(self.request('tester',path,HOSTS[1],'POST',b'{}')[0],403)
            for host in [HOSTS[0],HOSTS[2],HOSTS[3]]:
                self.assertIn(self.request('tester',path,host)[0],[403,404])

    def test_paid_review3_exact_approved_bytes_keep_host_and_method_boundary(self):
        root=ROOT/'docs/legal/closed-paid-test/2026-10-16-review-3'
        approval=json.loads((root/'approval-record.json').read_bytes())
        self.assertEqual(hashlib.sha256((root/'SHA256SUMS').read_bytes()).hexdigest(),approval['approvedPackageSha256'])
        proposal=json.loads((root/'release-proposal.json').read_bytes())
        for document in proposal['candidateDocuments']:
            path='/__closed_legal/paid-test/2026-10-16-review-3/'+document['kind']+'.md'
            status,headers,raw=self.request('tester',path,HOSTS[1])
            self.assertEqual(status,200);self.assertEqual(headers['cache-control'],'no-store')
            self.assertEqual(hashlib.sha256(raw).hexdigest(),document['sha256'])
            self.assertEqual(self.request('tester',path,HOSTS[1],'POST',b'{}')[0],403)
            for host in [HOSTS[0],HOSTS[2],HOSTS[3]]:
                self.assertIn(self.request('tester',path,host)[0],[403,404])

    def test_paid_review4_candidate_bytes_keep_host_and_method_boundary(self):
        root=ROOT/'docs/legal/closed-paid-test/2026-10-16-review-4'
        approval=json.loads((root/'approval-record.json').read_bytes())
        self.assertEqual(hashlib.sha256((root/'SHA256SUMS').read_bytes()).hexdigest(),approval['packageSha256'])
        proposal=json.loads((root/'release-proposal.json').read_bytes())
        for document in proposal['candidateDocuments']:
            path='/__closed_legal/paid-test/2026-10-16-review-4/'+document['kind']+'.md'
            status,headers,raw=self.request('tester',path,HOSTS[1])
            self.assertEqual(status,200);self.assertEqual(headers['cache-control'],'no-store')
            self.assertEqual(hashlib.sha256(raw).hexdigest(),document['sha256'])
            self.assertEqual(self.request('tester',path,HOSTS[1],'POST',b'{}')[0],403)
            for host in [HOSTS[0],HOSTS[2],HOSTS[3]]:
                self.assertIn(self.request('tester',path,host)[0],[403,404])

if __name__=='__main__':unittest.main()
