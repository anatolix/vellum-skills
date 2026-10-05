import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Authenticated local IPC, never assistant text or a tool. Failures are non-fatal.
export async function publishShimUI(message, {socketPath=process.env.SHIM_UI_SOCKET, timeoutMs=750}={}) {
  if (!socketPath) return false;
  return new Promise(resolve => {
    const id=randomUUID(); let bytes=Buffer.alloc(0), ended=false;
    const socket=connect(socketPath);
    const finish=ok=>{if(ended)return;ended=true;clearTimeout(timer);socket.destroy();resolve(ok);};
    const timer=setTimeout(()=>finish(false),timeoutMs);
    socket.on('error',()=>finish(false)); socket.on('end',()=>finish(false));
    socket.on('connect',()=>{
      const event={id:randomUUID(),conversationId:message.conversationId,emittedAt:new Date().toISOString(),message};
      const data=Buffer.from(JSON.stringify({id,method:'/events/publish',params:{body:{event}}}));
      const head=Buffer.alloc(4);head.writeUInt32BE(data.length);socket.write(Buffer.concat([head,data]));
    });
    socket.on('data',chunk=>{
      bytes=Buffer.concat([bytes,chunk]);
      if(bytes.length<4)return;
      const n=bytes.readUInt32BE(0);if(n>1024*1024)return finish(false);
      if(bytes.length<n+4)return;
      try{const response=JSON.parse(bytes.subarray(4,4+n));finish(response.id===id&&!response.error);}catch{finish(false);}
    });
  });
}
