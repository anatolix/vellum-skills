import { test, expect } from 'bun:test';
import { NoticeTransport, isCompactionRequest, noticeFrame } from './notice-transport.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const url='http://localhost/v1/chat/completions';
const tool={type:'function',function:{name:'example',parameters:{type:'object',properties:{}}}};
const body=(text,extra={})=>({model:'gpt-6.1-sol',prompt_cache_key:'routing-test',tools:[tool],reasoning_effort:'high',messages:[{role:'user',content:text}],...extra});
const req=(b,headers={})=>new Request(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(b)});
const instruction='<compaction_instructions>\nSummarize.\n</compaction_instructions>';
test('explicit operation independent of mainAgent and absent tool_choice',()=>expect(isCompactionRequest(req(body('opaque'),{'x-shim-operation':'compact','x-call-site':'mainAgent'}),body('opaque'))).toBe(true));
test('legacy compactionAgent header',()=>expect(isCompactionRequest(req(body('opaque'),{'x-call-site':'compactionAgent'}),body('opaque'))).toBe(true));
test('instruction fallback with reasoning and no tool_choice',()=>expect(isCompactionRequest(req(body(instruction)),body(instruction))).toBe(true));
test('neutral tool_choice object does not affect operation',()=>expect(isCompactionRequest(req(body(instruction,{tool_choice:{type:'none'}})),body(instruction,{tool_choice:{type:'none'}}))).toBe(true));
test('multipart text fallback',()=>{const b=body([{type:'text',text:'\n'+instruction}]);expect(isCompactionRequest(req(b),b)).toBe(true)});
test('emergency compaction fallback',()=>expect(isCompactionRequest(req(body('<emergency_compaction>summary</emergency_compaction>')),body('<emergency_compaction>summary</emergency_compaction>'))).toBe(true));
test('quoted tag in ordinary prose is not compaction',()=>{const b=body('Explain this tag:\n'+instruction);expect(isCompactionRequest(req(b),b)).toBe(false)});
test('old instruction in history is not current operation',()=>{const b=body('Test');b.messages.unshift({role:'user',content:instruction});expect(isCompactionRequest(req(b),b)).toBe(false)});
test('no user message is not compaction',()=>{const b=body('');b.messages=[];expect(isCompactionRequest(req(b),b)).toBe(false)});
for (const marker of ['header','instruction']) test(`transport bypass precedes pending continuation: ${marker}`,async()=>{
 const t=new NoticeTransport();const pending={callId:'old-notice',active:false};t.pending.set('routing-test',pending);
 const b=body(marker==='header'?'opaque':instruction);let calls=0;
 const response=await t.fetch(req(b,marker==='header'?{'x-shim-operation':'compact','x-call-site':'mainAgent'}:{}),async inner=>{calls++;expect((await inner.json()).reasoning_effort).toBe('high');return new Response('<compaction_result>SUMMARY</compaction_result>')});
 expect(calls).toBe(1);expect(await response.text()).toBe('<compaction_result>SUMMARY</compaction_result>');expect(t.pending.get('routing-test')).toBe(pending);
});
test('compaction creates no diagnostic park; following Test uses its own handler',async()=>{
 const t=new NoticeTransport();let calls=0;
 const handler=async inner=>{calls++;const b=await inner.json();return new Response('data: '+JSON.stringify({choices:[{delta:{content:b.messages.at(-1).content===instruction?'SUMMARY':'TEST-ANSWER'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})};
 expect(await (await t.fetch(req(body(instruction)),handler)).text()).toContain('SUMMARY');expect(t.pending.size).toBe(0);
 expect(await (await t.fetch(req(body('Test')),handler)).text()).toContain('TEST-ANSWER');expect(calls).toBe(2);
});
test('normal diagnostics still park and resume SAME reader after acknowledgement',async()=>{
 const t=new NoticeTransport();let calls=0;
 const handler=async()=>{calls++;return new Response(noticeFrame('normal start')+'data: '+JSON.stringify({choices:[{delta:{content:'NORMAL-ANSWER'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})};
 const first=await (await t.fetch(req(body('normal')),handler)).text();expect(first).toContain('__shim_notice__');const pending=t.pending.get('routing-test');expect(pending).toBeDefined();
 const b=body('normal');b.messages.push({role:'tool',tool_call_id:pending.callId,content:'Unknown tool'});
 const second=await (await t.fetch(req(b),handler)).text();expect(second).toContain('NORMAL-ANSWER');expect(calls).toBe(1);expect(t.pending.size).toBe(0);
});
test('both handlers share the transport predicate',()=>{
 const here=fileURLToPath(new URL('.',import.meta.url));
 for(const path of [here+'server-v2.js',here+'../../claude-code-shim-provider/scripts/server-v3.js']){
  const s=readFileSync(path,'utf8');expect(s).toContain('isCompactionRequest(req, body)');expect(s).not.toContain('if (callSite === "compactionAgent" ||');
 }
});
