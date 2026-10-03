// Shim-only diagnostics. The reserved, deliberately unregistered tool is rejected
// by Vellum before execution. Its activity is the red UI label. NEVER advertise it
// to the model; strip both its call and result before sending history upstream.
import { randomUUID } from 'node:crypto';
export const NOTICE_TOOL = '__shim_notice__';
const PREFIX = 'call_shim_notice_';
const SEP = '\n\n-------------------\n\n';
const enc = new TextEncoder();
export function cleanNotices(messages = []) {
  const ids = new Set();
  for (const m of messages) for (const t of m.tool_calls || [])
    if (t.function?.name === NOTICE_TOOL && t.id?.startsWith(PREFIX)) ids.add(t.id);
  return messages.flatMap(m => {
    if (m.role === 'tool' && ids.has(m.tool_call_id)) return [];
    if (m.role !== 'assistant') return [m];
    const tc = m.tool_calls?.filter(t => !ids.has(t.id));
    if (m.tool_calls?.length && !tc.length) return [];
    return [{ ...m, ...(tc ? {tool_calls: tc} : {}) }];
  });
}
export function noticeText(source, event, detail) { return `[${source}] ${event}: ${detail}`; }
export function noticeFrame(text) { return `data: ${JSON.stringify({shim_notice: String(text)})}\n\n`; }
export class NoticeTransport {
  constructor({ttlMs = 900000, mode = process.env.SHIM_NOTICE_FMT || 'tool'} = {}) {
    this.pending = new Map(); this.later = new Map(); this.ttlMs = ttlMs; this.mode = mode;
  }
  queue(key, text) {
    const q = this.later.get(key) || [];
    q.push(text); this.later.set(key, q.slice(-20));
    // Bounded diagnostic-only cache, not part of the CLI pool.
    if (this.later.size > 1000) this.later.delete(this.later.keys().next().value);
  }
  async fetch(req, handler) {
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/v1/chat/completions') return handler(req);
    let body; try { body = await req.clone().json(); } catch { return handler(req); }
    const key = body.prompt_cache_key || req.headers.get('x-conversation-id');
    const enabled = this.mode === 'tool' && !!key && !String(key).startsWith('router-oneuse-') && body.tools?.length > 0
      && body.tool_choice !== 'none' && !body.response_format;
    const pending = this.pending.get(key);
    if (pending) {
      if (pending.active) return Response.json({error:{message:'shim diagnostic continuation already active'}},{status:409});
      const ack = body.messages?.some(m => m.role === 'tool' && m.tool_call_id === pending.callId);
      if (!ack) return this.single(pending);
      clearTimeout(pending.timer); pending.active = true;
      return this.resume(pending, true);
    }
    body.messages = cleanNotices(body.messages);
    // Detached request lifetime: the diagnostic response ends BEFORE inference.
    // A new HTTP request resumes the SAME reader, never another upstream turn.
    const abort = new AbortController();
    const inner = new Request(req.url, {method:req.method, headers:req.headers, body:JSON.stringify(body), signal:abort.signal});
    let upstream; try { upstream = await handler(inner); } catch(e) { abort.abort(); throw e; }
    if (!upstream.ok || !upstream.headers.get('content-type')?.includes('text/event-stream')) return upstream;
    const st = {key, model:body.model, reader:upstream.body.getReader(), decoder:new TextDecoder(), buf:'',
      queue:this.later.get(key) || [], enabled, active:true, abort, visible:false, id:'chatcmpl-shim-'+randomUUID()};
    this.later.delete(key);
    return this.resume(st, false);
  }
  single(st) {
    const base = {id:st.id, object:'chat.completion.chunk', created:Math.floor(Date.now()/1000), model:st.model};
    const chunk = (delta, finish_reason=null) => `data: ${JSON.stringify({...base,choices:[{index:0,delta,finish_reason}]})}\n\n`;
    return new Response(chunk({role:'assistant', content:SEP}) + chunk({tool_calls:[{index:0,id:st.callId,type:'function',function:{name:NOTICE_TOOL,arguments:JSON.stringify({activity:st.notice})}}]}) + chunk({},'tool_calls') + 'data: [DONE]\n\n',
      {headers:{'content-type':'text/event-stream','cache-control':'no-cache'}});
  }
  async frame(st) {
    for (;;) {
      const at = st.buf.indexOf('\n\n');
      if (at >= 0) {const out=st.buf.slice(0,at+2);st.buf=st.buf.slice(at+2);return out;}
      const r=await st.reader.read();
      if(r.done){const tail=st.buf;st.buf='';return tail || null;}
      st.buf+=st.decoder.decode(r.value,{stream:true}).replace(/\r\n/g,'\n');
    }
  }
  drop(st) { clearTimeout(st.timer); if(this.pending.get(st.key)===st)this.pending.delete(st.key); }
  park(st, notice) {
    st.notice=notice;st.callId=PREFIX+randomUUID();st.active=false;
    this.pending.set(st.key,st);
    st.timer=setTimeout(()=>{this.drop(st);st.abort.abort();void st.reader.cancel().catch(()=>{});},this.ttlMs);
    st.timer.unref?.();
  }
  async resume(st, continuation) {
    const self=this;
    return new Response(new ReadableStream({
      async start(controller){
        let live=true,visible=false;
        const emit=s=>{if(live)controller.enqueue(enc.encode(s));};
        const timer=setInterval(()=>{try{emit(": keepalive\n\n");}catch{}},15000);
        try{
          emit(": shim transport\n\n");
          for(;;){
            const f=st.queue.length ? noticeFrame(st.queue.shift()) : await self.frame(st);
            if(f===null)break;
            let o;try{o=f.startsWith('data: ') ? JSON.parse(f.slice(6).trim()) : null;}catch{}
            if(o?.shim_notice){
              if(st.enabled && !visible){
                self.park(st,o.shim_notice);
                emit(await self.single(st).text());
                controller.close();return;
              }
              console.log('[shim-notice]',o.shim_notice);
              if(st.enabled)self.queue(st.key,o.shim_notice);
              continue;
            }
            if(!visible && o?.choices?.some(c=>c.delta?.content || c.delta?.reasoning_content || c.delta?.tool_calls)){
              visible=true;
              if(continuation)emit(`data: ${JSON.stringify({id:st.id,object:'chat.completion.chunk',model:st.model,choices:[{index:0,delta:{content:SEP},finish_reason:null}]})}\n\n`);
            }
            emit(f);
          }
          self.drop(st);controller.close();
        }catch(e){self.drop(st);st.abort.abort();try{controller.error(e);}catch{}}
        finally{live=false;clearInterval(timer);}
      },
      cancel(){self.drop(st);st.abort.abort();void st.reader.cancel().catch(()=>{});}
    }),{headers:{'content-type':'text/event-stream','cache-control':'no-cache'}});
  }
}
