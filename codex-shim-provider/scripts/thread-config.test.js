import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { codexThreadConfig, codexResumeParams } from './thread-config.js';
for (const nativeTools of [false, true]) {
  test(`native agents stay disabled (nativeTools=${nativeTools})`, () => {
    const c=codexThreadConfig({ nativeTools });
    expect(c.agents.enabled).toBe(false);
    expect(c.features.multi_agent).toBe(false);
    expect(c.features.multi_agent_v2).toBe(false);
    expect(c.web_search).toBe("disabled");
    expect(c.features.image_generation).toBe(false);
    expect(c.features.view_image).toBe(false);
    for (const flag of ['include_permissions_instructions','include_environment_context','include_collaboration_mode_instructions','include_apps_instructions']) expect(c[flag]).toBe(false);
    if (!nativeTools) for (const flag of ['shell_tool','unified_exec','plugins','apps']) expect(c.features[flag]).toBe(false);
    expect(c.sandbox).toBeUndefined();expect(c.approvalPolicy).toBeUndefined();
  });
}
test('all start/resume paths use the same native-agent policy', () => {
  const s=readFileSync(new URL('./server-v2.js',import.meta.url),'utf8');
  expect((s.match(/codexResumeParams\(state\.threadId, \{ sandbox: SANDBOX \}\)/g)||[]).length).toBe(2);
  expect((s.match(/config: \{ \.\.\.codexThreadConfig\(\)/g)||[]).length).toBe(1);
});

test('resume params restate sandbox and approval policy', () => {
  const p = codexResumeParams('t1', { sandbox: 'read-only' });
  expect(p).toMatchObject({ threadId: 't1', excludeTurns: true, approvalPolicy: 'never', sandbox: 'read-only' });
  expect(p.config.features.view_image).toBe(false);
});

test('server-v2 uses codexResumeParams for every thread/resume', () => {
  const src = readFileSync(new URL('./server-v2.js', import.meta.url), 'utf8');
  const resumes = src.match(/srv\.request\("thread\/resume"[^\n]*/g) || [];
  expect(resumes.length).toBeGreaterThan(0);
  for (const r of resumes) expect(r).toContain('codexResumeParams(state.threadId, { sandbox: SANDBOX })');
});
