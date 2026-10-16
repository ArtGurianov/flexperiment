#!/usr/bin/env python3
"""Render a bounded isolated provider fixture, never an application deployment."""
import json,re,sys
IMAGE='ghcr.io/artgurianov/flexperiment-commerce-v2@sha256:c928ef2a9e33e2e2bcb7e646e89fe8b239489395539d9eb9094350a683433e4c'
ROOT='/root/flexperiment-artifacts/art36-qualification-20261016/fixture-runtime'

def render(scope):
    if not isinstance(scope,str) or not re.fullmatch('[a-f0-9]{32}',scope):
        raise ValueError('ART36_SCOPE_REFUSED')
    name='art36-fixture-'+scope[:12]
    path='/__art36/'+scope+'/authorize'
    router='art36-fixture-'+scope[:12]
    compose={'services':{'fixture':{'image':IMAGE,'container_name':name,'entrypoint':['node','/opt/art36/provider-fixture.mjs'],'command':[],
        'user':'1000:1000','read_only':True,'restart':'no','cap_drop':['ALL'],'security_opt':['no-new-privileges:true'],
        'mem_limit':'256m','pids_limit':64,'tmpfs':['/tmp:rw,nosuid,nodev,noexec,size=16m'],
        'volumes':[ROOT+'/provider-fixture.mjs:/opt/art36/provider-fixture.mjs:ro',ROOT+'/fixture.json:/run/art36/fixture.json:ro'],
        'networks':['coolify'],'labels':{'com.flexperiment.purpose':'art36-isolated-provider-fixture','com.flexperiment.fixture-scope':scope},
        'healthcheck':{'test':['CMD','node','-e',"fetch('http://127.0.0.1:8087/healthz').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"],
            'interval':'10s','timeout':'3s','retries':2,'start_period':'2s'}}},'networks':{'coolify':{'external':True}}}
    route={'http':{'routers':{router:{'rule':'Host(`canary-api.flexperiment.ru`) && Method(`POST`) && Path(`'+path+'`)','entryPoints':['https'],
        'priority':10001,'service':router,'middlewares':[router+'-body',router+'-rate',router+'-headers'],'tls':{}}},
        'services':{router:{'loadBalancer':{'serversTransport':router,'servers':[{'url':'http://'+name+':8087'}]}}},
        'serversTransports':{router:{'forwardingTimeouts':{'dialTimeout':'2s','responseHeaderTimeout':'9s'}}},
        'middlewares':{router+'-body':{'buffering':{'maxRequestBodyBytes':8192}},router+'-rate':{'rateLimit':{'average':6,'period':'1s','burst':12}},
            router+'-headers':{'headers':{'customResponseHeaders':{'Cache-Control':'no-store'},'accessControlAllowMethods':[]}}}}}
    return {'scope':'art36-isolated-provider-only','fixtureName':name,'path':path,'callbackUrl':'https://canary-api.flexperiment.ru'+path,
        'compose':compose,'route':route,'routeFile':'/data/coolify/proxy/dynamic/'+router+'.yaml'}

if __name__=='__main__':
    if len(sys.argv)!=2:raise SystemExit('Usage: fixture-manifest.py <32-lowercase-hex-scope>')
    print(json.dumps(render(sys.argv[1]),indent=2))
