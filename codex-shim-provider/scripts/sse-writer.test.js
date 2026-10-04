import { test, expect } from 'bun:test';
import { createSseWriter } from './sse-writer.js';
import { readFileSync } from 'node:fs';
const invalid = () => Object.assign(new TypeError('Controller is already closed'), { code: 'ERR_INVALID_STATE' });
test('normal writes preserve SSE bytes', () => {
  const chunks=[]; const w=createSseWriter({enqueue:x=>chunks.push(new TextDecoder().decode(x)),close(){}});
  expect(w.write('data: привет\n\n')).toBe(true);expect(chunks).toEqual(['data: привет\n\n']);
});
test('close is idempotent and suppresses all late writes', () => {
  let closes=0,writes=0;const w=createSseWriter({enqueue(){writes++},close(){closes++}});
  expect(w.close()).toBe(true);expect(w.close()).toBe(false);expect(w.write('late')).toBe(false);
  expect(closes).toBe(1);expect(writes).toBe(0);expect(w.closed).toBe(true);
});
test('close marks closed before reentrant callback',()=>{
  let w;w=createSseWriter({enqueue(){throw Error('late')},close(){expect(w.closed).toBe(true);expect(w.write('late')).toBe(false)}});w.close();
});
test('cancel does not close an already cancelled controller',()=>{
  const w=createSseWriter({enqueue(){throw Error('bad')},close(){throw Error('bad')}});
  w.cancel();w.cancel();expect(w.close()).toBe(false);expect(w.write('late')).toBe(false);
});
test('implicit cancellation catches only closed-controller errors',()=>{
  let writes=0;const w=createSseWriter({enqueue(){writes++;throw invalid()},close(){throw invalid()}});
  expect(w.write('late')).toBe(false);expect(w.write('later')).toBe(false);expect(w.close()).toBe(false);expect(writes).toBe(1);
});
test('already closed controller at close is harmless',()=>{
  const w=createSseWriter({close(){throw invalid()}});expect(w.close()).toBe(false);expect(w.closed).toBe(true);
});
test('unrelated enqueue errors are not hidden',()=>{
  const e=new Error('real failure');const w=createSseWriter({enqueue(){throw e}});expect(()=>w.write('x')).toThrow('real failure');expect(w.closed).toBe(false);
});
test('unrelated close errors are not hidden',()=>{
  const w=createSseWriter({close(){throw Error('real failure')}});expect(()=>w.close()).toThrow('real failure');expect(w.closed).toBe(true);
});
test('real stream cancellation tolerates late notifications',async()=>{
  let w;const stream=new ReadableStream({start(c){w=createSseWriter(c)},cancel(){w.cancel()}});
  const r=stream.getReader();await r.cancel();expect(w.write('reasoning')).toBe(false);expect(w.close()).toBe(false);
});
test('real externally closed stream tolerates late notifications',async()=>{
  let w,c;const stream=new ReadableStream({start(x){c=x;w=createSseWriter(x)}});c.close();expect(w.write('reasoning')).toBe(false);expect(w.closed).toBe(true);expect((await stream.getReader().read()).done).toBe(true);
});
test('chat and compaction both wire cancellation to safe writer',()=>{
  const s=readFileSync(new URL('./server-v2.js',import.meta.url),'utf8');expect(s.match(/res = createSseWriter\(controller\)/g)?.length).toBe(2);expect(s.match(/cancel\(\) \{ res\?\.cancel\(\); \}/g)?.length).toBe(2);expect(s).not.toContain('controller.enqueue(enc.encode(s))');
});
