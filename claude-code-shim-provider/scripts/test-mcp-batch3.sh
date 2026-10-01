#!/bin/bash
# Patch: batch closes only when collected tool_uses == content_block_start(tool_use) count; log why. Then 3-tool test on :8319.
set -u
cd /home/vellum/claude-shim && cp server.js server.js.bak-pre-batch2 && python3 - <<'PY'
p="/home/vellum/claude-shim/server.js"; t=open(p).read()
def rep(a,b):
    global t; assert t.count(a)==1, a[:70]; t=t.replace(a,b,1)
rep('''          let batchTimer = null;    // fallback if message_stop never arrives''',
'''          let batchTimer = null;    // fallback if message_stop never arrives
          let expectedTus = 0, msgStopped = false, batchWhy = "";   // content_block_start(tool_use) count vs collected assistant tool_use blocks
          const closeBatch = (why) => { if (batchWhy) return; batchWhy = why; clearTimeout(batchTimer); turnDone?.(); };''')
rep('''              if (tus.length) { toolUses.push(...tus); if (!batchTimer) batchTimer = setTimeout(() => turnDone?.(), 2000); }
            }
            if (mcpMode && toolUses.length && msg.type === "stream_event" && msg.event?.type === "message_stop") { clearTimeout(batchTimer); turnDone?.(); }''',
'''              if (tus.length) {
                toolUses.push(...tus);
                if (!batchTimer) batchTimer = setTimeout(() => closeBatch("timer"), 1500);
                if (msgStopped && toolUses.length >= expectedTus) closeBatch("late-block");
              }
            }
            if (mcpMode && msg.type === "stream_event" && msg.event?.type === "content_block_start" && msg.event.content_block?.type === "tool_use") expectedTus++;
            if (mcpMode && msg.type === "stream_event" && msg.event?.type === "message_stop") {
              msgStopped = true;
              if (toolUses.length && toolUses.length >= expectedTus) closeBatch("stop");
            }''')
rep('''              clearTimeout(batchTimer);
              const tool_calls = toolUses.map(''',
'''              clearTimeout(batchTimer);
              console.log(`[mcp] batch closed: ${batchWhy || "run-done"} collected=${toolUses.length} expected=${expectedTus}`);
              const tool_calls = toolUses.map(''')
open(p,"w").write(t); print("patched", len(t))
PY
node --check server.js && echo SYNTAX_OK || exit 1
W=/home/vellum/.local/share/vellum/assistants/juno/.vellum/workspace/scratch
bash $W/shim-mcp-start2.sh >/dev/null 2>&1; sleep 1
# 3-tool batch test
KEY=b3-$(date +%s); echo BETA > /tmp/beta.txt
TOOLS='[{"type":"function","function":{"name":"bash","description":"Execute a shell command","parameters":{"type":"object","properties":{"command":{"type":"string"},"activity":{"type":"string"}},"required":["command","activity"]}}},{"type":"function","function":{"name":"file_read","description":"Read a file","parameters":{"type":"object","properties":{"path":{"type":"string"},"activity":{"type":"string"}},"required":["path","activity"]}}},{"type":"function","function":{"name":"recall","description":"Search local memory","parameters":{"type":"object","properties":{"query":{"type":"string"},"activity":{"type":"string"},"depth":{"type":"string","enum":["fast","standard","deep"]}},"required":["query","activity"]}}}]'
SYS='{"role":"system","content":"Test agent. You MUST issue all requested tool calls together in ONE assistant message before seeing any result. Then answer in one short sentence."}'
U1='{"role":"user","content":"In ONE turn: run `echo alpha` with bash, read /tmp/beta.txt with file_read, AND recall with query `shim batch` depth fast. Then report all three results."}'
for round in 1 2; do
  curl -s -m 90 http://127.0.0.1:8319/v1/chat/completions -H 'content-type: application/json' -d "{\"model\":\"claude-sonnet\",\"prompt_cache_key\":\"$KEY\",\"tools\":$TOOLS,\"messages\":[$SYS,$U1]}" > /tmp/b3.sse
  python3 - <<'PY'
import json
calls={};fin=None;txt=""
for line in open('/tmp/b3.sse'):
    line=line.strip()
    if not line.startswith('data: ') or line=='data: [DONE]': continue
    d=json.loads(line[6:])
    for c in d.get('choices',[]):
        dl=c.get('delta',{}); txt+=dl.get('content') or ''
        for tc in dl.get('tool_calls',[]):
            e=calls.setdefault(tc['index'],{'id':tc.get('id'),'name':tc['function'].get('name'),'args':''}); e['args']+=tc['function'].get('arguments','')
        if c.get('finish_reason'): fin=c['finish_reason']
print('round: finish=',fin,'calls=',[(v['name'],v['args'][:40]) for v in calls.values()],'text=',txt[:100])
PY
  break
done
# resolve all three in one request
python3 - "$KEY" "$TOOLS" "$SYS" "$U1" <<'PY'
import json,sys,urllib.request
key,tools,sysm,u1=sys.argv[1],json.loads(sys.argv[2]),json.loads(sys.argv[3]),json.loads(sys.argv[4])
calls={}
for line in open('/tmp/b3.sse'):
    line=line.strip()
    if not line.startswith('data: ') or line=='data: [DONE]': continue
    d=json.loads(line[6:])
    for c in d.get('choices',[]):
        for tc in c.get('delta',{}).get('tool_calls',[]):
            e=calls.setdefault(tc['index'],{'id':tc.get('id'),'name':tc['function'].get('name'),'args':''}); e['args']+=tc['function'].get('arguments','')
cl=list(calls.values())
msgs=[sysm,u1,{"role":"assistant","content":None,"tool_calls":[{"id":c['id'],"type":"function","function":{"name":c['name'],"arguments":c['args']}} for c in cl]}]
res={'bash':'alpha','file_read':'BETA','recall':'Found evidence: 1. shim batch note'}
for c in cl: msgs.append({"role":"tool","tool_call_id":c['id'],"name":c['name'],"content":res.get(c['name'],'stub')})
body={"model":"claude-sonnet","prompt_cache_key":key,"tools":tools,"messages":msgs,"stream":True}
r=urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8319/v1/chat/completions",data=json.dumps(body).encode(),headers={"content-type":"application/json"}),timeout=120)
txt="";fin=None;extra=0
for line in r:
    line=line.decode().strip()
    if not line.startswith('data: ') or line=='data: [DONE]': continue
    d=json.loads(line[6:])
    for c in d.get('choices',[]):
        txt+=c.get('delta',{}).get('content') or ''; extra+=len(c.get('delta',{}).get('tool_calls',[]))
        if c.get('finish_reason'): fin=c['finish_reason']
print('step2: finish=',fin,'extra_calls=',extra,'text=',txt[:140])
PY
echo "== :8319 log"; journalctl --user -u shim-mcp-test2.service --since '-3min' --no-pager -o cat | grep -E '^\[(res|mcp|cli|err)' | tail -10
systemctl --user stop shim-mcp-test2.service; systemctl --user reset-failed shim-mcp-test2.service 2>/dev/null; rm -rf /tmp/shim-mcp-sessions2
