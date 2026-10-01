import json, sqlite3, time, shutil
W = '/home/vellum/.local/share/vellum/assistants/juno/.vellum/workspace'
db = W + '/data/db/assistant.db'
con = sqlite3.connect(db)
cols = [r[1] for r in con.execute('pragma table_info(provider_connections)')]
row = con.execute("select * from provider_connections where name='claude-code-mcp'").fetchone()
assert row, 'claude-code-mcp connection missing'
d = dict(zip(cols, row))
now = int(time.time() * 1000)
d['name'] = 'claude-code-v3'
d['label'] = 'ClaudeCliShim v3 (:8320)'
d['base_url'] = 'http://127.0.0.1:8320/v1'
d['models'] = json.dumps([{'id': 'claude-opus'}, {'id': 'claude-sonnet'}, {'id': 'claude-fable'}, {'id': 'claude-haiku'}])
for k in ('created_at', 'updated_at'):
    if k in d: d[k] = now
if not con.execute("select 1 from provider_connections where name='claude-code-v3'").fetchone():
    con.execute(f"insert into provider_connections ({','.join(cols)}) values ({','.join('?'*len(cols))})", [d[c] for c in cols])
    con.commit(); print('provider connection inserted')
else:
    print('provider connection exists')
con.close()
cfg = W + '/config.json'
shutil.copy(cfg, cfg + '.bak-20260930-v3')
c = json.load(open(cfg))
profiles = c['llm']['profiles']
src = profiles['claude-code-mcp-fable']
for mid, label in (('claude-opus', 'Opus'), ('claude-sonnet', 'Sonnet'), ('claude-fable', 'Fable'), ('claude-haiku', 'Haiku')):
    key = f'claude-code-v3-{mid.split("-")[1]}'
    p = json.loads(json.dumps(src))
    p['label'] = f'Claude Code v3 ({label})'
    p['provider_connection'] = 'claude-code-v3'
    p['model'] = mid
    profiles[key] = p
    print('profile', key)
json.dump(c, open(cfg, 'w'), indent=2, ensure_ascii=False)
