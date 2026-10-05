// Shim-only diagnostics. The reserved, deliberately unregistered tool is rejected
// by Vellum before execution. Its activity is the red UI label. NEVER advertise it
// to the model; strip both its call and result before sending history upstream.
import { randomUUID } from 'node:crypto';
export const NOTICE_TOOL = '__shim_notice__';
const PREFIX = 'call_shim_notice_';
const SEP = '\n\n-------------------\n\n';
// Channels that never render a failed tool's activity label (Telegram etc. deliver only the
// assistant text): notices go out as a plain "⚠ ..." text line instead of the fake tool call.
// Detected from the per-turn <turn_context> interface: / <channel_capabilities> channel: lines
// in the latest user block. SHIM_NOTICE_TEXT_INTERFACES overrides the list; "" disables.
const TEXT_INTERFACES = new Set((process.env.SHIM_NOTICE_TEXT_INTERFACES ?? 'telegram,whatsapp,slack,email,discord,phone,a2a').split(',').map(s => s.trim()).filter(Boolean));
export function turnInterface(messages = []) {
  const last = [...messages].reverse().find(m => m.role === 'user');
  const txt = typeof last?.content === 'string' ? last.content : (last?.content || []).map(p => p?.text || '').join('\n');
  const m = /<turn_context>[\s\S]*?^interface:\s*(\S+)/m.exec(txt) || /<channel_capabilities>[\s\S]*?^channel:\s*(\S+)/m.exec(txt);
  return m ? m[1] : null;
}
const enc = new TextEncoder();
export function cleanNotices(messages = []) {
  const ids = new Set();
  for (const m of messages) for (const t of m.tool_calls || [])
    if (t.function?.name === NOTICE_TOOL && t.id?.startsWith(PREFIX)) ids.add(t.id);
  // Vellum answers every rejected notice call with an error result AND a follow-up
  // <system_notice> user message ("This tool call returned an error..."). Both belong
  // to the fake call: drop the notice too, or the model reads a retry hint after each one.
  let afterNotice = false;
  return messages.flatMap(m => {
    if (m.role === 'tool' && ids.has(m.tool_call_id)) { afterNotice = true; return []; }
    const wasAfter = afterNotice; afterNotice = false;
    if (wasAfter && m.role === 'user' && isSystemNoticeOnly(m)) return [];
    if (m.role !== 'assistant') return [m];
    const tc = m.tool_calls?.filter(t => !ids.has(t.id));
    if (m.tool_calls?.length && !tc.length) return [];
    return [{ ...m, ...(tc ? {tool_calls: tc} : {}) }];
  });
}
function isSystemNoticeOnly(m) {
  const t = (typeof m.content === 'string' ? m.content
    : (m.content || []).map(p => (p?.type === 'text' ? p.text : '\u0000')).join('\n')).trim();
  return /^<system_notice>[\s\S]*<\/system_notice>$/.test(t) && !/<\/system_notice>[\s\S]*<system_notice>/.test(t);
}
export function noticeText(source, event, detail) { return `[${source}] ${event}: ${detail}`; }
export function noticeFrame(text) { return `data: ${JSON.stringify({shim_notice: String(text)})}\n\n`; }
// One predicate for the transport and BOTH handlers, before diagnostic continuation.
// Routing stays mainAgent; compaction intent is separate from profile/cache selection.
export function isCompactionRequest(req, body) {
  if (req.headers.get('x-shim-operation') === 'compact' ||
      req.headers.get('x-call-site') === 'compactionAgent') return true;
  // Compatibility with older Vellum daemons. Only the final user's opening tag counts:
  // a quoted tag in earlier history or ordinary prose must never trigger compaction.
  const last = [...(body?.messages || [])].reverse().find(m => m.role === 'user');
  if (!last) return false;
  const text = typeof last.content === 'string' ? last.content
    : Array.isArray(last.content) ? last.content.map(p => p?.text || '').join('\n') : '';
  return /^\s*<(compaction_instructions|emergency_compaction)>/.test(text);
}

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
    // Vellum sends X-Call-Site: mainAgent even for compaction (COMPACTION_CALL_SITE='mainAgent' in
    // compactor.ts; 'compactionAgent' is only the log label) — recognise the instruction block instead.
    if (isCompactionRequest(req, body)) {
      // Vellum's summary call must come back as plain parseable text: no notice frames, no parking.
      body.messages = cleanNotices(body.messages);
      return handler(new Request(req.url, {method:req.method, headers:req.headers, body:JSON.stringify(body)}));
    }
    const iface = turnInterface(body.messages);
    const textMode = !!key && !String(key).startsWith('router-oneuse-') && TEXT_INTERFACES.has(iface);
    const enabled = !textMode && this.mode === 'tool' && !!key && !String(key).startsWith('router-oneuse-') && body.tools?.length > 0
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
      queue:this.later.get(key) || [], enabled, textMode, iface, active:true, abort, visible:false, id:'chatcmpl-shim-'+randomUUID()};
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
              if(st.textMode){
                // text channel: one plain warning line before the answer, never a tool call
                console.log('[shim-notice]',`(text:${st.iface})`,o.shim_notice);
                emit(`data: ${JSON.stringify({id:st.id,object:'chat.completion.chunk',model:st.model,choices:[{index:0,delta:{content:`⚠ ${o.shim_notice}\n\n`},finish_reason:null}]})}\n\n`);
                continue;
              }
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
