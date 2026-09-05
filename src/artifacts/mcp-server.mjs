#!/usr/bin/env node
import { readFile, appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createArtifactViewer, createArtifactTools } from './index.mjs';

export async function serveArtifactMcp({ manifestPath, input = process.stdin, output = process.stdout }) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const registry = createArtifactTools(await createArtifactViewer(manifest));
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let request;
    try {
      if (Buffer.byteLength(line) > 64 * 1024) throw new Error('Request too large');
      request = JSON.parse(line);
      if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') throw new Error('Invalid JSON-RPC envelope');
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC request' } })}\n`);
      continue;
    }
    if (request.id === undefined) continue;
    let result;
    try {
      if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'ccdd-artifact-runner', version: '0.1.0' }, instructions: 'Read-only viewer entry points scoped to this request and snapshot.' };
      else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/list') result = { tools: registry.tools };
      else if (request.method === 'tools/call') {
        try {
          const data = await registry.call(request.params?.name, request.params?.arguments ?? {});
          if (manifest.auditPath) await appendFile(manifest.auditPath, `${JSON.stringify({ name: request.params.name, arguments: request.params.arguments ?? {}, at: new Date().toISOString() })}\n`, { mode: 0o600 });
          result = { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false };
        } catch (error) { result = { content: [{ type: 'text', text: error.message }], isError: true }; }
      } else {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })}\n`);
        continue;
      }
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Artifact viewer unavailable' } })}\n`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveArtifactMcp({ manifestPath: process.argv[2] }).catch(() => { process.stderr.write('CCDD artifact viewer failed to initialize\n'); process.exitCode = 1; });
}
