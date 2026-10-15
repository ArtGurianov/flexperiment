#!/usr/bin/env python3
"""Closed ART337 Compose inputs/readback/backup. No operation runs on import."""
import argparse
import base64
import functools
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import subprocess
import sys
sys.dont_write_bytecode = True
import time
import urllib.request
import uuid

SOURCE = '08523bdf38eeddf5e745ce04d05e1f980a7ced93'
LEGACY_IMAGES = {
    'commerce': 'ghcr.io/artgurianov/flexperiment-commerce-v2@sha256:ae982e7629f93db45ebc79b9ef623756f13da85fb7b2a5a91d7e47a926754c92',
    'platform': 'ghcr.io/artgurianov/flexperiment-platform-v2@sha256:8414358ba700c48e18891346e62e6cd9ea7658fb669114860c356ead1a4a6e46',
    'admin': 'ghcr.io/artgurianov/flexperiment-admin-v2@sha256:85eadc71e50fdab0bc4d154a242a46188bd85bbe7f0edfed516f8863eb14dc77',
}
ORIGINAL = 'xzuy7pk5y6ywjr9kh6nsk5ap'
INPUT = Path('/etc/flexperiment-fast-cut-canary')
BACKUPS = Path('/var/backups/flexperiment-fast-cut-canary')
STACK = Path('/opt/flexperiment-fast-cut-canary/deploy/v2/fast-cut/compose.json')
ERASURE = Path('/var/lib/flexperiment-erasure-canary')
SCHEMA = 'c99f9ed0db449a2c13f2e51fa3b28a1ba44e367dd263185c99eddfec8c2d3b39'
DATABASE = Path('/var/lib/docker/volumes/'+ORIGINAL+'-'+ORIGINAL+'-commerce-v2-data/_data/commerce.sqlite')
ORIGINS = {key:'https://canary-'+name+'.flexperiment.ru' for key,name in
           [('PLATFORM_ORIGIN','platform'),('LAB_ORIGIN','lab'),('ADMIN_ORIGIN','admin'),('API_ORIGIN','api')]}


def require(value, code):
    if not value: raise ValueError(code)


def run(args, timeout=180):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout)
    require(result.returncode == 0, 'FAST_CUT_COMMAND_FAILED')
    return result.stdout


def private(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
            and stat.S_IMODE(info.st_mode) == 0o600, 'FAST_CUT_PRIVATE_CUSTODY')
    return path.read_bytes()


def write(path, raw):
    descriptor = os.open(path, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as handle:
        handle.write(raw); handle.flush(); os.fsync(handle.fileno())


def validate_release(value):
    require(isinstance(value, dict) and set(value) == {'schema', 'scope', 'roles'}
            and value['schema'] == 'flexperiment.closed-canary-release/1' and value['scope'] == 'canary'
            and isinstance(value['roles'], dict) and set(value['roles']) == set(LEGACY_IMAGES), 'FAST_CUT_RELEASE_INVALID')
    for role, row in value['roles'].items():
        require(isinstance(row, dict) and set(row) == {'sourceCommit', 'imageReference'}
                and isinstance(row['sourceCommit'], str) and re.fullmatch('[a-f0-9]{40}', row['sourceCommit'])
                and isinstance(row['imageReference'], str) and re.fullmatch(
                    'ghcr.io/artgurianov/flexperiment-'+role+r'-v2@sha256:[a-f0-9]{64}', row['imageReference']),
                'FAST_CUT_RELEASE_INVALID')
    # Each immutable artifact keeps its own native source identity. Platform's
    # expected upstream is checked separately against the Commerce role below.
    return value['roles']


@functools.lru_cache(maxsize=1)
def release():
    # Host-owned observation contract, installed only under a separate execution
    # GO. It cannot change images/env or grant erasure admission. Pin one vector
    # for this CLI process; runtime image readbacks still have to match it.
    path = INPUT/'release.json'
    try:
        info = path.lstat()
    except FileNotFoundError:
        return {role: {'sourceCommit': SOURCE, 'imageReference': image} for role, image in LEGACY_IMAGES.items()}
    require(info.st_size <= 4096, 'FAST_CUT_RELEASE_INVALID')
    def unique(pairs):
        result = {}
        for key, item in pairs:
            require(key not in result, 'FAST_CUT_RELEASE_INVALID'); result[key] = item
        return result
    return validate_release(json.loads(private(path), object_pairs_hook=unique))


def raw_env(values):
    for key,value in values.items():
        require(re.fullmatch(r'[A-Z][A-Z0-9_]*',key) and isinstance(value,str)
                and not any(c in value for c in '\r\n\0'), 'FAST_CUT_ENV_INVALID')
    return ''.join(key+'='+values[key]+'\n' for key in sorted(values)).encode()


def prepare():
    require(os.geteuid()==0 and not INPUT.exists(), 'FAST_CUT_INPUT_EXISTS_OR_NOT_ROOT')
    token = private(Path('/root/flexperiment-v2-owner/coolify-api.token')).decode().strip()
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args): raise ValueError('FAST_CUT_REDIRECT_REFUSED')
    def get(path):
        request=urllib.request.Request('https://coolify.refref.ru/api/v1'+path,headers={'Authorization':'Bearer '+token})
        with urllib.request.build_opener(NoRedirect).open(request,timeout=20) as response:
            raw=response.read(2000001)
        require(len(raw)<=2000000,'FAST_CUT_RESPONSE_LIMIT');return json.loads(raw)
    app=get('/applications/'+ORIGINAL)
    require(app['environment']['name']=='canary-v2' and app['git_commit_sha']==SOURCE
            and str(app['status']).startswith(('exited','stopped')), 'FAST_CUT_SOURCE_SCOPE')
    rows=get('/applications/'+ORIGINAL+'/envs')
    rows=[v for v in rows if not v.get('is_preview') and v.get('is_runtime')]
    require(len(rows)==len({v['key'] for v in rows}), 'FAST_CUT_SOURCE_AMBIGUOUS')
    values={v['key']:v.get('value') if v.get('is_literal') else v.get('real_value',v.get('value')) for v in rows}
    required={'SOURCE_COMMIT':SOURCE,'PAYMENT_MODE':'disabled','MARKETING_BROADCASTS_ENABLED':'false',
              'COMMERCE_V2_ENVIRONMENT':'canary','COMMERCE_V2_FOUNDATION_MODE':'false',
              'ERASURE_FENCING_ENABLED':'true','ERASURE_SCOPE':'canary',**ORIGINS}
    require(all(values.get(k)==v for k,v in required.items()) and not any(
        re.match(r'TOCHKA_|ALFA_|REFREF_API_KEY|REFUND_ENVELOPE_',k) and v for k,v in values.items()), 'FAST_CUT_INPUT_GUARD')
    INPUT.mkdir(mode=0o700)
    password=secrets.token_urlsafe(32);salt=secrets.token_bytes(16)
    encoded=lambda v:base64.urlsafe_b64encode(v).decode().rstrip('=')
    digest=hashlib.scrypt(password.encode(),salt=salt,n=16384,r=8,p=1,dklen=64,maxmem=64*1024*1024)
    values['COMMERCE_ADMIN_PASSWORD_SCRYPT']='scrypt:v1:16384:8:1:'+encoded(salt)+':'+encoded(digest)
    values['BUILD_IDENTITY_FILE']='/app/.identity/identity.json'
    write(INPUT/'commerce.env',raw_env(values));write(INPUT/'admin-password',password.encode())
    platform={'SOURCE_COMMIT':SOURCE,'NODE_ENV':'production','PORT':'3001','DEPLOY_ENV':'staging',
              'PLATFORM_V2_CANARY':'true','PAYMENT_MODE':'disabled','MARKETING_BROADCASTS_ENABLED':'false',
              'BUILD_IDENTITY_FILE':'/app/.identity/identity.json','PLATFORM_EXPECTED_COMMERCE_SHA':SOURCE,
              'COMMERCE_INTERNAL_ORIGIN':'http://'+ORIGINAL+':3002',**ORIGINS}
    write(INPUT/'platform.env',raw_env(platform))
    return {'state':'PRIVATE_INPUTS_PREPARED','canaryAdminPasswordChanged':True,'originalInputsUnchanged':True}


def inspect(role):
    manifest=json.loads(STACK.read_bytes());expected=manifest['services'][role]
    expected_release=release()[role]
    require(expected['image']==expected_release['imageReference'], 'FAST_CUT_RELEASE_IMAGE_MISMATCH')
    name=expected['container_name'];container=json.loads(run(['docker','inspect',name]))[0]
    image=json.loads(run(['docker','image','inspect',expected['image']]))[0]
    qualified=json.loads(private(INPUT/(role+'-artifact.json')))
    require(container['Config']['Image']==expected['image'] and container['Image']==image['Id']==qualified['imageId']
            and image['RootFS']['Layers']==qualified['rootfs'] and (image['Os'],image['Architecture'])==('linux','amd64'), 'FAST_CUT_IMAGE_DRIFT')
    require(container['State']['Running'] and not container['HostConfig'].get('PortBindings')
            and container['HostConfig']['ReadonlyRootfs'] and set(container['NetworkSettings']['Networks'])=={'flexperiment-fast-cut-canary'}
            and container['Config']['Labels'].get('com.flexperiment.scope')=='canary-fast-cut', 'FAST_CUT_RUNTIME_SCOPE')
    for field in ['User','Entrypoint','Cmd','WorkingDir']:
        actual, original = container['Config'].get(field), image['Config'].get(field)
        # Docker canonicalizes an unspecified native nginx user from null to
        # empty string. Both mean the image default root, not an override.
        if field == 'User' and original is None: original = ''
        require(actual == original, 'FAST_CUT_EXECUTION_OVERRIDE')
    path='/usr/share/nginx/html/release.json' if role=='admin' else '/app/.identity/identity.json'
    identity=json.loads(run(['docker','exec',name,'cat',path]))
    require(identity==qualified['identity'],'FAST_CUT_IDENTITY_DRIFT')
    native_source='source_commit' if role=='admin' else 'sourceCommit'
    require(identity.get(native_source)==expected_release['sourceCommit'], 'FAST_CUT_RELEASE_SOURCE_MISMATCH')
    env=dict(v.split('=',1) for v in container['Config']['Env'] if '=' in v)
    if role!='admin':
        require(env.get('SOURCE_COMMIT')==expected_release['sourceCommit'], 'FAST_CUT_RELEASE_SOURCE_MISMATCH')
    if role=='commerce':
        require(env.get('PAYMENT_MODE')=='disabled' and env.get('ERASURE_FENCING_ENABLED')=='true'
                and env.get('ERASURE_SCOPE')=='canary' and env.get('MARKETING_BROADCASTS_ENABLED')=='false', 'FAST_CUT_COMMERCE_GUARD')
        mounts={v['Destination']:v for v in container['Mounts']}
        for folder,target,readonly in [('installation','/etc/flexperiment-erasure',True),('runtime-keys','/etc/flexperiment-erasure-keys',True),
                ('runtime-read','/etc/flexperiment-erasure-read',True),('mirror','/etc/flexperiment-erasure-mirror',True),('fence',str(ERASURE/'fence'),False)]:
            row=mounts.get(target);require(row and row['Source']==str(ERASURE/folder) and row['RW'] is not readonly,'FAST_CUT_ERASURE_MOUNT')
        for target,suffix in [('/var/lib/flexperiment-v2','commerce-v2-data'),('/var/lib/flexperiment-v2-backups','commerce-v2-backups')]:
            row=mounts.get(target);require(row and row['Name']==ORIGINAL+'-'+ORIGINAL+'-'+suffix and row['RW'],'FAST_CUT_DATA_MOUNT')
    if role=='platform':
        require(env.get('PLATFORM_V2_CANARY')=='true' and env.get('PLATFORM_EXPECTED_COMMERCE_SHA')==release()['commerce']['sourceCommit']
                and not any(k.startswith('PAYLOAD_') for k in env) and not any(v['Type'] in ('bind','volume') for v in container['Mounts']),'FAST_CUT_PLATFORM_PAYLOAD')
    return name,{'imageReference':expected['image'],'imageId':image['Id'],'rootfs':qualified['rootfs'],'identity':identity}


def check():
    result={'sourceCommit':release()['commerce']['sourceCommit'],'roles':{}}
    for role in ['commerce','platform','admin']:
        name,result['roles'][role]=inspect(role)
        if role=='commerce':
            ready=json.loads(run(['docker','exec',name,'curl','-fsS','--max-time','10','http://127.0.0.1:3002/readyz']))
            require(ready['ok'] and ready['foundationMode'] is False and ready['capabilities']['erasure']=='qualified'
                    and ready['core']['paymentMode']=='disabled' and ready['sourceCommit']==release()[role]['sourceCommit'],'FAST_CUT_COMMERCE_NOT_READY')
        elif role=='platform':
            raw=run(['docker','exec',name,'node','-e',"fetch('http://127.0.0.1:3001/readyz').then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))"])
            require(json.loads(raw)['sourceCommit']==release()[role]['sourceCommit'],'FAST_CUT_PLATFORM_NOT_READY')
        else:
            ready=json.loads(run(['docker','exec',name,'wget','-qO-','http://127.0.0.1/readyz']))
            # Native Admin identity is checked by inspect(). Its nginx /readyz
            # proxies Commerce, so this response identifies the upstream role.
            require(ready['sourceCommit']==release()['commerce']['sourceCommit'] and ready.get('service')=='commerce-v2'
                    and ready['ok'],'FAST_CUT_ADMIN_NOT_READY')
    db=sqlite3.connect(DATABASE.as_uri()+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
    rows=[dict(v) for v in db.execute("select type,name,tbl_name,sql from sqlite_master where name not like 'sqlite_%' order by type,name")]
    require(hashlib.sha256(json.dumps(rows,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()==SCHEMA
            and db.execute('select count(*) from schema_migrations').fetchone()[0]==26
            and db.execute('pragma integrity_check').fetchone()[0]=='ok' and not db.execute('pragma foreign_key_check').fetchall(),'FAST_CUT_SCHEMA')
    db.close();fence=sqlite3.connect((ERASURE/'fence'/'erasure-fence.sqlite').as_uri()+'?mode=ro',uri=True)
    state=fence.execute('select scope,state,sequence,owner from fence_state where id=1').fetchone()
    require(state[0:2]==('canary','OPEN') and state[3] is None and fence.execute('select count(*) from fence_leases').fetchone()[0]==0,'FAST_CUT_FENCE')
    fence.close();remote=json.loads(run(['/usr/local/bin/flexperiment-erasure','read']))
    require(remote['scope']=='canary' and remote['state']=='REMOTE_VERIFIED' and remote['sequence']==state[2],'FAST_CUT_REMOTE_LEDGER')
    result.update(schemaFingerprint=SCHEMA,fence='OPEN',ledgerSequence=state[2],leases=0,state='RUNTIME_CHECK_PASS_NOT_FINAL_ACCEPTANCE')
    return result


def smoke():
    values=dict(line.split('=',1) for line in private(INPUT/'commerce.env').decode().splitlines())
    inputs={'password':private(INPUT/'admin-password').decode(),'serviceToken':values['PLATFORM_SERVICE_TOKEN']}
    code=Path(__file__).with_name('fast-cut-smoke.mjs').read_text()
    result=subprocess.run(['docker','exec','-i','flexperiment-fast-cut-canary-commerce','node','--input-type=module','-e',code],
                          input=json.dumps(inputs).encode(),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=180)
    require(result.returncode==0,'FAST_CUT_INTERNAL_SMOKE_FAILED')
    report=json.loads(result.stdout);require(report.get('state')=='INTERNAL_SMOKE_PASS','FAST_CUT_INTERNAL_SMOKE_FAILED')
    return report


def transport():
    spec=importlib.util.spec_from_file_location('qualified_transport',Path(__file__).with_name('scheduled-backup.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def backup():
    check();name,_=inspect('commerce');proof=json.loads(run(['docker','exec',name,'node','--import','tsx','commerce-v2/src/backup-cli.ts'],timeout=900))
    source=release()['commerce']['sourceCommit']
    require(re.fullmatch('canary-'+source+r'-[a-f0-9-]{36}\.sqlite\.age',proof.get('filename','')),'FAST_CUT_BACKUP_IDENTITY')
    BACKUPS.mkdir(mode=0o700,parents=True,exist_ok=True)
    filename='fast-cut-'+time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())+'-'+str(uuid.uuid4())+'.sqlite.age';archive=BACKUPS/filename
    run(['docker','cp',name+':/var/lib/flexperiment-v2-backups/'+proof['filename'],str(archive)])
    os.chown(archive,0,0);archive.chmod(0o600);raw=private(archive);sha=hashlib.sha256(raw).hexdigest()
    require(sha==proof['sha256'] and len(raw)==proof['size'],'FAST_CUT_LOCAL_BACKUP_HASH')
    with archive.open('rb') as handle: os.fsync(handle.fileno())
    remote='cloud:art-backups/flexperiment/commerce-v2/canary/fast-cut/'+filename;b=transport()
    # Unique ciphertext object. Errors never retry the same PUT; retain archive.
    b.s3(BACKUPS,'rclone copyto "/backup/'+filename+'" "'+remote+'"')
    require(b.s3(BACKUPS,'rclone cat "'+remote+'" | sha256sum').decode().split()[0]==sha,'FAST_CUT_REMOTE_BACKUP_HASH')
    status={'status':'SUCCESS','sourceCommit':source,'verifiedAt':int(time.time()),'filename':filename,'object':remote,'sha256':sha,'size':len(raw)}
    temporary=BACKUPS/('.status-'+str(uuid.uuid4()));write(temporary,(json.dumps(status)+'\n').encode());os.replace(temporary,BACKUPS/'status.json')
    descriptor=os.open(BACKUPS,os.O_DIRECTORY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)
    return status


def check_backup():
    status=json.loads(private(BACKUPS/'status.json'))
    require(status['status']=='SUCCESS' and status['sourceCommit']==release()['commerce']['sourceCommit'] and 0<=time.time()-status['verifiedAt']<=8*3600
            and re.fullmatch(r'fast-cut-\d{8}T\d{6}Z-[a-f0-9-]{36}\.sqlite\.age',status['filename']),'FAST_CUT_BACKUP_STALE')
    raw=private(BACKUPS/status['filename']);require(hashlib.sha256(raw).hexdigest()==status['sha256'] and len(raw)==status['size'],'FAST_CUT_BACKUP_CHANGED')
    return {'status':'FRESH','verifiedAt':status['verifiedAt']}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('operation',choices=['prepare','check','smoke','backup','check-backup']);args=parser.parse_args()
    try:
        print(json.dumps({'prepare':prepare,'check':check,'smoke':smoke,'backup':backup,'check-backup':check_backup}[args.operation]()))
    except Exception:
        # Exceptions may contain private API responses/env. Never emit their text.
        print(json.dumps({'state':'FAST_CUT_HOLD','operation':args.operation}));raise SystemExit(1)
