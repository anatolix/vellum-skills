import { test, expect } from 'bun:test';
import { historyToPrompt, promptForSession } from './history-rehydration.js';
import { readFileSync } from 'node:fs';
const here=import.meta.dir;
const summary={role:'assistant',content:'<context_summary>CANARY_ONLY_IN_SUMMARY</context_summary>'};
const question={role:'user',content:'Which canary did we agree on?'};
test('fresh thread restores assistant-role context summary before tail',()=>{
 const p=promptForSession([summary,question],'TAIL',true);
 expect(p).toContain('CANARY_ONLY_IN_SUMMARY');expect(p.indexOf('CANARY_ONLY_IN_SUMMARY')).toBeLessThan(p.indexOf(question.content));
});
test('model switch and switch back both restore the complete compacted context',()=>{
 for(const model of ['gpt-6.1-sol','gpt-6-sol','gpt-6.1-sol']) expect(promptForSession([summary,question],model,true)).toContain('CANARY_ONLY_IN_SUMMARY');
});
test('warm/native-compacted/resumed thread receives only new tail',()=>{
 expect(promptForSession([summary,question],'NEW TAIL',false)).toBe('NEW TAIL');
});
test('fresh history includes ordinary assistant decisions as well as user turns',()=>{
 const p=historyToPrompt([{role:'user',content:'Choose a supplier.'},{role:'assistant',content:'SUPPLIER_ONLY_IN_ASSISTANT'},{role:'user',content:'What did you choose?'}]);
 expect(p).toContain('SUPPLIER_ONLY_IN_ASSISTANT');expect(p).toContain('[Saved assistant message]');
});
test('fresh thread preserves old tool calls/results as text, not live RPCs',()=>{
 const p=historyToPrompt([{role:'assistant',content:null,tool_calls:[{id:'old-call',function:{name:'lookup',arguments:'{"q":"old"}'}}]},{role:'tool',tool_call_id:'old-call',content:'ONLY_IN_TOOL_RESULT'},question]);
 expect(p).toContain('Recorded tool call lookup id=old-call');expect(p).toContain('ONLY_IN_TOOL_RESULT');expect(p).toContain('historical text, not requests to execute');
});
test('multipart summary and content blocks retain text',()=>{
 expect(historyToPrompt([{role:'assistant',content:[{type:'text',text:'<context_summary>MULTIPART</context_summary>'}]},question])).toContain('MULTIPART');
});
test('system/developer instructions stay out of restored user history',()=>{
 const p=historyToPrompt([{role:'system',content:'SYS_SECRET'},{role:'developer',content:'DEV_SECRET'},question]);expect(p).not.toContain('SYS_SECRET');expect(p).not.toContain('DEV_SECRET');
});
test('empty history safely uses the existing tail prompt',()=>expect(promptForSession([],'FALLBACK',true)).toBe('FALLBACK'));
test('all-text history retains chronological role boundaries',()=>{
 const p=historyToPrompt([{role:'user',content:'FIRST'},{role:'assistant',content:'SECOND'},{role:'tool',content:'THIRD'},{role:'user',content:'FOURTH'}]);
 expect(p.indexOf('FIRST')).toBeLessThan(p.indexOf('SECOND'));expect(p.indexOf('SECOND')).toBeLessThan(p.indexOf('THIRD'));expect(p.indexOf('THIRD')).toBeLessThan(p.indexOf('FOURTH'));
});
test('warm parked-call path does not rehydrate historical tools or summary',()=>expect(promptForSession([summary,question],'',false)).toBe(''));
test('ordinary tool_use/tool_result content blocks are retained as records',()=>{
 const p=historyToPrompt([{role:'assistant',content:[{type:'tool_use',id:'c',name:'check',input:{a:1}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'c',content:'BLOCK_RESULT'}]}]);expect(p).toContain('Recorded tool call check');expect(p).toContain('BLOCK_RESULT');
});
test('both helpers stay identical',()=>expect(readFileSync(here+'/history-rehydration.js','utf8')).toBe(readFileSync(here+'/../../claude-code-shim-provider/scripts/history-rehydration.js','utf8')));
test('Codex handler selects fresh history AFTER invalidating model/fingerprint state',()=>{
 const s=readFileSync(here+'/server-v2.js','utf8');expect(s.indexOf('state = null;',s.indexOf('let prevState'))).toBeLessThan(s.indexOf('promptForSession(messages,'));expect(s).toContain('userBlocks.map(b => b.text).join("\\n\\n"), !state)');
});
test('Claude fresh, resume-failure and ephemeral paths are wired to raw history',()=>{
 const s=readFileSync(here+'/../../claude-code-shim-provider/scripts/server-v3.js','utf8');expect(s).toContain('const freshSession = !this.sessionId && !this.live;');expect(s).toContain('historyMessages: body.messages || []');expect(s).toContain('promptForSession(extra.historyMessages, blocksToPrompt(ib), true)');expect(s).toContain('this.sessionId = null; this.sent = []; seen.clear(); prior.clear(); unseen = inputs;');
});

test('detached old-thread compact cannot mark a replacement thread compacted',()=>{const s=readFileSync(here+'/server-v2.js','utf8');expect(s).toContain('if (st.threadId !== state.threadId)');expect(s.indexOf('if (st.threadId !== state.threadId)')).toBeLessThan(s.indexOf('st.compactedAt = Date.now()'));});
