import { test, expect } from 'bun:test';
const version=process.env.SHIM_UI_TEST_VERSION || '0.12.8';
const root=`/home/vellum/.local/share/vellum/assistants/juno/.vellum/runtime/${version}/node_modules/@vellumai/assistant/src`;
const { OpenAIChatCompletionsProvider }=await import(`${root}/providers/openai/chat-completions-provider.ts`);
const { AnthropicProvider }=await import(`${root}/providers/anthropic/client.ts`);
const crud=await import(`${root}/persistence/conversation-crud.ts`);
test(`runtime ${version} exposes required persistence API`,()=>{
 for(const name of ['getMessages','getMessageById','updateMessageContent']) expect(typeof crud[name]).toBe('function');
});
const history:any=[{role:'assistant',content:[{type:'text',text:'answer'},{type:'ui_surface',surfaceId:'shim-ui:test',surfaceType:'card',data:{body:'🔴 **notice** Cached 8 · Uncached 2 · Out 1'}}]}];
test('runtime OpenAI serializer excludes native UI surface from next provider request',async()=>{
 const p:any=new OpenAIChatCompletionsProvider('test-placeholder','test-model'); const wire=await p.toOpenAIMessages(history); const raw=JSON.stringify(wire);
 expect(raw).toContain('answer'); for(const s of ['ui_surface','shim-ui:test','notice','Cached 8']) expect(raw).not.toContain(s);
});
test('runtime Anthropic serializer excludes native UI surface on model switch',async()=>{
 const p:any=new AnthropicProvider('test-placeholder','claude-sonnet-4-6'); const wire=await p.buildSentMessages(history); const raw=JSON.stringify(wire);
 expect(raw).toContain('answer'); for(const s of ['ui_surface','shim-ui:test','notice','Cached 8']) expect(raw).not.toContain(s);
});
