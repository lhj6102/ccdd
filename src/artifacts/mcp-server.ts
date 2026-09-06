#!/usr/bin/env node
import { readFile, appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import type { ArtifactReference, ArtifactViewerOptions } from './index.js';
import type { ConfigManifest } from '../tools/contracts.js';
import { createReviewTools, toToolContent } from '../tools/runner.js';
import { packageVersion } from '../runtime-paths.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Artifact viewer unavailable';
interface ArtifactManifest extends ArtifactViewerOptions { auditPath?: string; configManifest?: ConfigManifest; runDir?: string; criticId?: string }
interface McpRequest { jsonrpc: '2.0'; id?: unknown; method: string; params?: unknown }

function artifactReference(value: unknown): value is ArtifactReference {
  return object(value) && typeof value.id === 'string' && typeof value.type === 'string' && typeof value.path === 'string';
}
function parseManifest(value: unknown): ArtifactManifest {
  if (!object(value) || typeof value.worktreePath !== 'string' || !Array.isArray(value.artifacts) || !value.artifacts.every(artifactReference) ||
      (value.artifactTypes !== undefined && !object(value.artifactTypes)) || (value.auditPath !== undefined && typeof value.auditPath !== 'string') ||
      (value.runDir !== undefined && typeof value.runDir !== 'string') || (value.criticId !== undefined && typeof value.criticId !== 'string') || (value.configManifest !== undefined && !object(value.configManifest))) {
    throw new Error('Invalid Artifact MCP manifest');
  }
  return { worktreePath: value.worktreePath, artifacts: value.artifacts, artifactTypes: value.artifactTypes, auditPath: value.auditPath, configManifest: value.configManifest as ConfigManifest | undefined, runDir: value.runDir, criticId: value.criticId };
}
function parseRequest(line: string): McpRequest {
  if (Buffer.byteLength(line) > 64 * 1024) throw new Error('Request too large');
  const value: unknown = JSON.parse(line);
  if (!object(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string') throw new Error('Invalid JSON-RPC envelope');
  return { jsonrpc: '2.0', id: value.id, method: value.method, params: value.params };
}

export async function serveArtifactMcp({ manifestPath, input = process.stdin, output = process.stdout }: {
  manifestPath: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): Promise<void> {
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown);
  const registry = await createReviewTools({ ...manifest, audience: 'agent',
    onCall: async call => {
      if (manifest.auditPath) await appendFile(manifest.auditPath, `${JSON.stringify(call)}\n`, { mode: 0o600 });
    },
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let request: McpRequest;
      try { request = parseRequest(line); }
      catch {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC request' } })}\n`);
        continue;
      }
      if (request.id === undefined) continue;
      let result: unknown;
      try {
        if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'ccdd-artifact-runner', version: packageVersion }, instructions: 'Observation entry points scoped to the declared Artifacts in this prepared review input. Follow each tool description and input schema; results may contain text, structured data or images. Listing a directory or launching a program alone does not observe its contents.' };
        else if (request.method === 'ping') result = {};
        else if (request.method === 'tools/list') result = { tools: registry.tools };
        else if (request.method === 'tools/call') {
          try {
            const params = object(request.params) ? request.params : {};
            if (typeof params.name !== 'string') throw new Error('Unknown artifact tool');
            const args = params.arguments === undefined ? {} : params.arguments;
            const data = await registry.call(params.name, args);
            result = { content: await toToolContent(data), isError: false };
          } catch (error) { result = { content: [{ type: 'text', text: errorMessage(error) }], isError: true }; }
        } else {
          output.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })}\n`);
          continue;
        }
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
      } catch {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Artifact viewer unavailable' } })}\n`);
      }
    }
  } finally {
    lines.close();
    await registry.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifestPath = process.argv[2];
  if (!manifestPath) { process.stderr.write('CCDD artifact viewer requires a manifest path\n'); process.exitCode = 1; }
  else serveArtifactMcp({ manifestPath }).catch(() => { process.stderr.write('CCDD artifact viewer failed to initialize\n'); process.exitCode = 1; });
}
