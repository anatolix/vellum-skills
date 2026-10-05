import { test, expect } from 'bun:test';
import { OpenAIChatCompletionsProvider } from 'file:///home/vellum/.local/share/vellum/assistants/juno/.vellum/runtime/0.12.6/node_modules/@vellumai/assistant/src/providers/openai/chat-completions-provider.ts';
import { AnthropicProvider } from 'file:///home/vellum/.local/share/vellum/assistants/juno/.vellum/runtime/0.12.6/node_modules/@vellumai/assistant/src/providers/anthropic/client.ts';
const history:any=[{role:'assistant',content:[{type:'text',text:'answer'},{type:'ui_surface',surfaceId:'shim-ui:test',surfaceType:'card',data:{body:'🔴 **notice** Cached 8 · Uncached 2 · Out 1'}}]}];
test('runtime OpenAI serializer excludes native UI surface from next provider request',async()=>{
 const p:any=new OpenAIChatCompletionsProvider('test-placeholder','test-model'); const wire=await p.toOpenAIMessages(history); const raw=JSON.stringify(wire);
 expect(raw).toContain('answer'); for(const s of ['ui_surface','shim-ui:test','notice','Cached 8']) expect(raw).not.toContain(s);
});
test('runtime Anthropic serializer excludes native UI surface on model switch',async()=>{
 const p:any=new AnthropicProvider('test-placeholder','claude-sonnet-4-6'); const wire=await p.buildSentMessages(history); const raw=JSON.stringify(wire);
 expect(raw).toContain('answer'); for(const s of ['ui_surface','shim-ui:test','notice','Cached 8']) expect(raw).not.toContain(s);
});
