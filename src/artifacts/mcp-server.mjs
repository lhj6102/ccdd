#!/usr/bin/env node
import { readFile, appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createArtifactViewer, createArtifactTools } from './index.mjs';

export async function serveArtifactMcp({ manifestPath, input = process.stdin, output = process.stdout }) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
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
      if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'ccdd-artifact-runner', version }, instructions: 'Read-only viewer entry points scoped to the declared Artifacts in this prepared review input. Tool descriptions explain each operation and its observation scope. Read by one-based startLine and lineCount; follow nextStartLine to continue. Listing a directory does not read its files.' };
      else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/list') result = { tools: registry.tools };
      else if (request.method === 'tools/call') {
        try {
          const args = request.params?.arguments === undefined ? {} : request.params.arguments;
          const data = await registry.call(request.params?.name, args);
          const observation = {
            artifactId: data.artifactId, operation: Array.isArray(data.entries) ? 'list' : 'read',
            ...Object.fromEntries(['startLine', 'endLine', 'lineCount', 'totalLines'].filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]])),
          };
          if (manifest.auditPath) await appendFile(manifest.auditPath, `${JSON.stringify({ name: request.params.name, arguments: args, observation, at: new Date().toISOString() })}\n`, { mode: 0o600 });
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
