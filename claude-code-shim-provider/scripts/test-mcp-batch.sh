#!/bin/bash
# Batch test: ask for two commands at once → expect 2 tool_calls in one reply, then resolve both.
KEY=batch-$(date +%s)
TOOLS='[{"type":"function","function":{"name":"bash","description":"Execute a shell command","parameters":{"type":"object","properties":{"command":{"type":"string"},"activity":{"type":"string"}},"required":["command","activity"]}}},{"type":"function","function":{"name":"file_read","description":"Read a file","parameters":{"type":"object","properties":{"path":{"type":"string"},"activity":{"type":"string"}},"required":["path","activity"]}}}]'
SYS='{"role":"system","content":"Test agent. Do exactly what is asked using the tools, You MUST issue both tool calls together in a single assistant message, before seeing any result. Then answer in one short sentence."}'
U1='{"role":"user","content":"In ONE turn, run `echo alpha` with bash AND read the file /tmp/beta.txt with file_read. Then tell me both outputs."}'
curl -s -m 60 http://127.0.0.1:8318/v1/chat/completions -H 'content-type: application/json' -d "{\"model\":\"claude-sonnet\",\"prompt_cache_key\":\"$KEY\",\"tools\":$TOOLS,\"messages\":[$SYS,$U1]}" > /tmp/b1.sse
python3 - <<'EOF'
import json,re
sse=open('/tmp/b1.sse').read()
calls=[]
for line in sse.split('\n'):
    if not line.startswith('data: ') or line.strip()=='data: [DONE]': continue
    d=json.loads(line[6:])
    for ch in d.get('choices',[]):
        for tc in ch.get('delta',{}).get('tool_calls') or []: calls.append(tc)
print('tool_calls:',[(c['id'][:14],c['function']['name'],c['function']['arguments'][:50]) for c in calls])
json.dump(calls,open('/tmp/b1.calls.json','w'))
EOF
sleep 2
python3 - "$KEY" "$TOOLS" "$SYS" "$U1" <<'EOF'
import json,sys,subprocess
key,tools,sysm,u1=sys.argv[1:5]
calls=json.load(open('/tmp/b1.calls.json'))
assistant={"role":"assistant","content":None,"tool_calls":[{"id":c["id"],"type":"function","function":c["function"]} for c in calls]}
results=[]
for c in calls:
    out='alpha\n' if c['function']['name']=='bash' else 'BETA FILE CONTENT'
    results.append({"role":"tool","tool_call_id":c["id"],"name":c["function"]["name"],"content":out})
body={"model":"claude-sonnet","prompt_cache_key":key,"tools":json.loads(tools),"messages":[json.loads(sysm),json.loads(u1),assistant]+results}
open('/tmp/b2.json','w').write(json.dumps(body))
EOF
curl -s -m 90 http://127.0.0.1:8318/v1/chat/completions -H 'content-type: application/json' -d @/tmp/b2.json > /tmp/b2.sse
python3 - <<'EOF'
import json
text='';fin=None;tcs=0
for line in open('/tmp/b2.sse'):
    if not line.startswith('data: ') or line.strip()=='data: [DONE]': continue
    d=json.loads(line[6:])
    for ch in d.get('choices',[]):
        text+=ch.get('delta',{}).get('content') or ''
        if ch.get('delta',{}).get('tool_calls'): tcs+=1
        fin=ch.get('finish_reason') or fin
print('final:',repr(text[:200]),'finish=',fin,'extra tool_calls=',tcs)
import re
print('second-step tool_calls:',re.findall(r'"name":"([a-z_]+)"',open('/tmp/b2.sse').read())[:4])
EOF
echo '== shim log'
grep -E '\[(res|sess|mcp|cli|err|warn)' /dev/null | tail -8 | cut -c1-180
