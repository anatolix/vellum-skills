// UI-only diagnostics; legacy notice tools are cleaned, never generated.
import { UUID, publishShimUI } from './shim-ui-transport.js';
export const NOTICE_TOOL = '__shim_notice__';
const PREFIX = 'call_shim_notice_';
export function turnInterface(messages = []) {
  const last = [...messages].reverse().find(m => m.role === 'user');
  const txt = typeof last?.content === 'string' ? last.content : (last?.content || []).map(p => p?.text || '').join('\n');
  const m = /<turn_context>[\s\S]*?^interface:\s*(\S+)/m.exec(txt) || /<channel_capabilities>[\s\S]*?^channel:\s*(\S+)/m.exec(txt);
  return m ? m[1] : null;
}
const enc = new TextEncoder();
export function cleanNotices(messages = [], vellum = null) {
  const ids = new Set();
  for (const m of messages) for (const t of m.tool_calls || [])
    if (t.function?.name === NOTICE_TOOL && t.id?.startsWith(PREFIX)) ids.add(t.id);
  // Vellum answers every rejected notice call with an error result AND a follow-up
  // <system_notice> user message ("This tool call returned an error..."). Both belong
  // to the fake call: drop the notice too, or the model reads a retry hint after each one.
  let afterNotice = false;
  const kept = []; // original index of every surviving message, in order
  const out = messages.flatMap((m, i) => {
    if (m.role === 'tool' && ids.has(m.tool_call_id)) { afterNotice = true; return []; }
    const wasAfter = afterNotice; afterNotice = false;
    if (wasAfter && m.role === 'user' && isSystemNoticeOnly(m)) return [];
    if (m.role !== 'assistant') { kept.push(i); return [m]; }
    const tc = m.tool_calls?.filter(t => !ids.has(t.id));
    if (m.tool_calls?.length && !tc.length) return [];
    kept.push(i);
    return [{ ...m, ...(tc ? {tool_calls: tc} : {}) }];
  });
  remapSourceIndexes(vellum, kept);
  return out;
}
// Vellum's `_vellum.messages[].index` addresses the ORIGINAL wire list (local patch 8). After
// dropping notice messages every later index would point past its message, so the row ids
// would land on the wrong blocks. Renumber in place; entries for dropped messages go away.
function remapSourceIndexes(vellum, kept) {
  if (!vellum || !Array.isArray(vellum.messages)) return;
  const pos = new Map(kept.map((orig, j) => [orig, j]));
  vellum.messages = vellum.messages.flatMap(e => pos.has(e?.index) ? [{ ...e, index: pos.get(e.index) }] : []);
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
  constructor({source='claude-shim',publish=publishShimUI}={}) { this.source=source;this.publish=publish;this.later=new Map(); }
  queue(key,text) {
    const q=this.later.get(key)||[];q.push({text:String(text),ts:Date.now()});this.later.set(key,q.slice(-20));
    if(this.later.size>1000)this.later.delete(this.later.keys().next().value);
  }
  async fetch(req,handler) {
    if(req.method!=='POST'||new URL(req.url).pathname!=='/v1/chat/completions')return handler(req);
    let body;try{body=await req.clone().json();}catch{return handler(req);}
    const key=body.prompt_cache_key||req.headers.get('x-conversation-id');
    const replyId=body._vellum?.reply_id;
    const callSite=req.headers.get('x-call-site');
    const enabled=UUID.test(key||'')&&UUID.test(replyId||'')&&(!callSite||callSite==='mainAgent')
      &&req.headers.get('x-shim-dry-run')!=='1'&&!isCompactionRequest(req,body)&&!body.response_format;
    body.messages=cleanNotices(body.messages,body._vellum);
    const inner=new Request(req.url,{method:req.method,headers:req.headers,body:JSON.stringify(body),signal:req.signal});
    const upstream=await handler(inner);
    if(!upstream.ok||!upstream.headers.get('content-type')?.includes('text/event-stream')||!upstream.body)return upstream;
    const self=this,reader=upstream.body.getReader(),decoder=new TextDecoder();let buf='',completed=false,cancelled=false;
    const queued=(this.later.get(key)||[]).filter(x=>Date.now()-x.ts<900000);this.later.delete(key);
    let notices=0;
    async function metadata(kind,extra={}) {
      if(!enabled||cancelled)return;
      if(kind==='notice'&&++notices>40)return;
      const message={type:'hook_event',conversationId:key,hookName:'shim-ui',owner:{kind:'plugin',id:'shim-ui-transport'},
        detail:{kind,source:self.source,replyId,model:body.model,...extra}};
      try{const ok=await self.publish(message);if(ok===false)console.warn('[shim-ui] sidechannel unavailable (no text fallback)');}
      catch(e){console.warn('[shim-ui] non-fatal publish failure:',String(e?.message||e));}
    }
    const complete=async()=>{if(!completed){completed=true;await metadata('complete');}};
    async function frame(){
      for(;;){const at=buf.indexOf('\n\n');if(at>=0){const f=buf.slice(0,at+2);buf=buf.slice(at+2);return f;}
        const r=await reader.read();if(r.done){buf+=decoder.decode();const tail=buf;buf='';return tail||null;}
        buf+=decoder.decode(r.value,{stream:true});buf=buf.replace(/\r\n/g,'\n');
        if(buf.length>16*1024*1024)throw new Error('SSE frame too large');
      }
    }
    return new Response(new ReadableStream({
      async start(controller){
        try{
          for(const n of queued)await metadata('notice',{text:n.text});
          for(;;){
            const f=await frame();if(f===null){await complete();break;}
            const data=f.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');
            let o;try{o=JSON.parse(data);}catch{}
            if(typeof o?.shim_notice==='string'){
              console.log('[shim-notice]',o.shim_notice);await metadata('notice',{text:o.shim_notice.slice(0,4096)});continue;
            }
            if(o?.usage&&typeof o.usage==='object')await metadata('usage',{usage:o.usage});
            if(data.trim()==='[DONE]')await complete();
            if(!cancelled)controller.enqueue(enc.encode(f));
          }
          if(!cancelled)controller.close();
        }catch(e){if(!cancelled)controller.error(e);void reader.cancel().catch(()=>{});}
      },
      cancel(){cancelled=true;void reader.cancel().catch(()=>{});}
    }),{status:upstream.status,headers:upstream.headers});
  }
}
