import { registerHooks, syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
const denied = () => { throw new Error('Offline load-check guard blocked a network/provider operation.'); };
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.includes('pi-ai') || specifier.includes('pi-agent-core') || /executors\/(pi|auth)\.[cm]?[jt]s$/.test(specifier)) return denied();
  return nextResolve(specifier, context);
} });
http.request = denied; http.get = denied; https.request = denied; https.get = denied;
net.connect = denied; net.createConnection = denied; net.Socket.prototype.connect = denied; tls.connect = denied;
globalThis.fetch = denied;
syncBuiltinESMExports();
Reflect.set(globalThis, Symbol.for('ccdd.offline-guard'), true);
