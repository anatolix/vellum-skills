#!/usr/bin/env python3
"""Cancelled HTTP + late reasoning must not kill shim. Fake app-server, no model."""
import json, os, pathlib, shutil, signal, socket, subprocess, sys, tempfile, time, urllib.request

def fake():
    def send(x): print(json.dumps(x), flush=True)
    def notif(t, method, **p): send({'method':method,'params':{'threadId':t,**p}})
    for line in sys.stdin:
        m=json.loads(line);mid=m.get('id');p=m.get('params',{});method=m.get('method')
        if method=='initialize': send({'id':mid,'result':{}})
        elif method=='model/list': send({'id':mid,'result':{'data':[{'id':'mock-model'}]}})
        elif method=='thread/start': send({'id':mid,'result':{'thread':{'id':'fake-thread'}}})
        elif method=='thread/resume': send({'id':mid,'result':{'thread':{'id':p['threadId']}}})
        elif method=='turn/start':
            tid=p['threadId'];text=p['input'][0]['text']
            send({'id':mid,'result':{'turn':{'id':'fake-turn'}}})
            notif(tid,'item/agentMessage/delta',delta='FIRST')
            if 'DISCONNECT' in text:
                time.sleep(0.8)
                for i in range(5):
                    notif(tid,'item/reasoning/summaryTextDelta',itemId='r1',delta='LATE_REASONING')
                    time.sleep(0.08)
                notif(tid,'item/reasoning/summaryPartAdded',itemId='r1')
            notif(tid,'item/agentMessage/delta',delta='OK')
            notif(tid,'turn/completed',turn={'id':'fake-turn','status':'completed'})
        elif mid is not None: send({'id':mid,'result':{}})

def run():
    here=pathlib.Path(__file__).resolve();shim=os.environ.get('SHIM_UNDER_TEST',str(here.parent.parent/'scripts/server-v2.js'))
    with tempfile.TemporaryDirectory(prefix='codex-disconnect-') as tmp:
        fakepath=pathlib.Path(tmp)/'fake-codex';shutil.copyfile(here,fakepath);fakepath.chmod(0o755)
        with socket.socket() as s: s.bind(('127.0.0.1',0));port=s.getsockname()[1]
        env={**os.environ,'CODEX_BIN':str(fakepath),'SHIM_PORT':str(port),'CODEX_WORKDIR':tmp+'/workdir','SHIM_SESSIONS_DIR':tmp+'/sessions','SHIM_FP_DIR':tmp+'/fp','SHIM_HISTEDIT_DIR':tmp+'/history','SHIM_MODELS':'mock-model','SHIM_NOTICE_FMT':'text'}
        log=open(tmp+'/log','w+');proc=subprocess.Popen([shutil.which('bun'),shim],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        url=f'http://127.0.0.1:{port}'
        def post(messages):
            req=urllib.request.Request(url+'/v1/chat/completions',json.dumps({'model':'mock-model','prompt_cache_key':'disconnect-test','messages':messages}).encode(),{'Content-Type':'application/json'})
            return urllib.request.urlopen(req,timeout=10)
        try:
            for _ in range(100):
                try:
                    with urllib.request.urlopen(url+'/v1/models',timeout=.2): break
                except Exception: time.sleep(.05)
            else: raise AssertionError('startup failed')
            history=[{'role':'user','content':'WARM'}]
            with post(history) as r: assert 'OK' in r.read().decode()
            history.append({'role':'user','content':'DISCONNECT'})
            r=post(history)
            while b'FIRST' not in r.readline(): pass
            r.close()  # response stream cancellation while app-server is still sending
            time.sleep(2)
            assert proc.poll() is None,'shim crashed after late notification'
            history.append({'role':'user','content':'AFTER_CANCEL'})
            with post(history) as r: wire=r.read().decode()
            assert 'OK' in wire and '[DONE]' in wire,wire
            assert proc.poll() is None,'shim restarted/crashed'
            states=[json.loads(p.read_text()) for p in pathlib.Path(tmp+'/sessions').glob('*.json') if p.name!='volatile-tools.json']
            assert len(states)==1 and states[0]['threadId']=='fake-thread',states
            print('PASS: HTTP cancellation + late reasoning; same shim PID, same thread, follow-up OK')
        finally:
            if proc.poll() is None: os.killpg(proc.pid,signal.SIGTERM)
            proc.wait(timeout=5);log.seek(0);logs=log.read();log.close()
            if 'ERR_INVALID_STATE' in logs or proc.returncode==1: print(logs,file=sys.stderr)

if __name__=='__main__':
    fake() if 'app-server' in sys.argv else run()
