import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import {syncBuiltinESMExports} from 'node:module';
export const network = {blocked:0};
const deny=()=>{network.blocked++;throw Error('PI60_NETWORK_DENIED');};
net.Socket.prototype.connect=deny;net.connect=deny;net.createConnection=deny;tls.connect=deny;
http.request=deny;http.get=deny;https.request=deny;https.get=deny;dns.lookup=deny;dns.resolve=deny;
globalThis.fetch=deny;globalThis.WebSocket=class{constructor(){deny();}};
syncBuiltinESMExports();
// Prove both common outgoing paths are denied before loading Pi.
for(const probe of [()=>fetch('https://chatgpt.com'),()=>net.connect(443,'chatgpt.com')]){try{probe();throw Error('guard failed');}catch(e){if(e.message!=='PI60_NETWORK_DENIED')throw e;}}
network.blocked=0;
