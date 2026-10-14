"""Remediate only this publisher's three erroneous first-run public packages."""
import json
import os
from pathlib import Path
import urllib.error
import urllib.request

IDS={'flexperiment-commerce-v2':15883058,'flexperiment-platform-v2':15883082,'flexperiment-admin-v2':15883052}
TAG='source085-run38512656998-attempt1'
if os.environ['GITHUB_REPOSITORY']!='ArtGurianov/flexperiment' or os.environ['GITHUB_REF']!='refs/heads/codex/art-337-ghcr-artifacts':
    raise ValueError('CLEANUP_SCOPE_REFUSED')
def api(path,method='GET',absent=False):
    request=urllib.request.Request('https://api.github.com/'+path,method=method,
      headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
    try:
        with urllib.request.urlopen(request,timeout=20) as response:
            if method=='DELETE':
                assert response.status==204;return None
            return json.load(response)
    except urllib.error.HTTPError as error:
        if absent and error.code==404:return None
        raise ValueError('CLEANUP_API_REFUSED_'+str(error.code)) from None
p=Path('cleanup-evidence');p.mkdir(mode=0o700)
validated=[]
for name,identity in IDS.items():
    path='users/ArtGurianov/packages/container/'+name
    package=api(path);versions=api(path+'/versions?per_page=100')
    assert package['id']==identity and package['name']==name and package['visibility']=='public'
    assert package.get('repository',{}).get('full_name')=='ArtGurianov/flexperiment'
    assert len(versions)==1 and versions[0]['metadata']['container']['tags']==[TAG]
    assert package['created_at']>='2026-10-14T04:40:00Z' and package['version_count']==1
    (p/(name+'-before.json')).write_text(json.dumps({'package':package,'versions':versions},indent=2))
    validated.append((name,path))
for name,path in validated:
    (p/(name+'-intent.json')).write_text(json.dumps({'operation':'DELETE_NEW_ERRONEOUS_PACKAGE','packageId':IDS[name],'uniqueTag':TAG}))
    api(path,method='DELETE')
    assert api(path,absent=True) is None
    (p/(name+'-outcome.json')).write_text(json.dumps({'state':'REMOVED_READBACK_404','packageId':IDS[name]}))
    print(json.dumps({'name':name,'packageId':IDS[name],'state':'REMOVED_READBACK_404'}))
