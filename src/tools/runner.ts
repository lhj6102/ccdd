import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ArtifactReference } from '../artifacts/index.js';
import { resolveArtifactScope } from '../artifacts/scope.js';
import type { ArtifactScope, ReviewToolCall } from '../contracts.js';
import { readWorkspaceConfig } from '../broker/config.js';
import { bestEffortDiagnostic } from '../executors/telemetry.js';
import { runProcess } from '../executors/process.js';
import type { ConfigManifest, JsonSchema, ScriptToolRequest, ToolMetadata, ToolResult } from './contracts.js';
import { metadata, object, jsonCopy, validateArguments } from './schema.js';
import { matchesToolManifest } from './manifest.js';
import { scopedPath, within } from './paths.js';
import { safeToolFailure, ToolResultError } from './diagnostics.js';

export interface ReviewToolDefinition {
  artifactId: string; operation: string; name: string; description: string;
  inputSchema: JsonSchema; metadata: ToolMetadata; annotations?: Record<string, boolean>;
}
export interface ReviewToolCheck { toolName: string; artifactId: string; ok: boolean; message: string; code?: string }
export interface ReviewToolRegistry {
  tools: ReviewToolDefinition[]; toolCalls: ReviewToolCall[]; outputDir: string;
  validateArguments(name: string, args: unknown): Record<string, unknown>;
  call(name: string, args?: unknown): Promise<ToolResult>;
  preflight(options?: { toolName?: string }): Promise<ReviewToolCheck[]>;
  close(): Promise<void>;
}
export interface ToolExecutionDiagnostic {
  name: string; artifactId: string; operation: string; startedAt: string; durationMs: number; outcome: 'success' | 'error';
  contentBytes: number; contentBytesByType: Record<'text' | 'json' | 'image' | 'launch', number>;
}
/** Payload bytes, not transport framing: UTF-8 text/JSON, decoded images and launch JSON. */
function responseBytes(result?: ToolResult) {
  const contentBytesByType = { text: 0, json: 0, image: 0, launch: 0 };
  for (const block of result?.content ?? []) {
    contentBytesByType[block.type] += block.type === 'image' ? Buffer.from('data' in block ? block.data : '', 'base64').length
      : Buffer.byteLength(block.type === 'text' ? block.text : JSON.stringify(block.type === 'json' ? block.data : { kind: 'launch', launched: block.launched }));
  }
  return { contentBytes: Object.values(contentBytesByType).reduce((sum, bytes) => sum + bytes, 0), contentBytesByType };
}
export interface ReviewToolsOptions {
  worktreePath: string; artifacts: readonly ArtifactReference[]; configManifest: ConfigManifest;
  audience: 'agent' | 'human'; runDir?: string; signal?: AbortSignal; criticId?: string;
  onCall?: (call: ReviewToolCall) => void | Promise<void>;
  onExecution?: (diagnostic: ToolExecutionDiagnostic) => void | Promise<void>;
}
export function describeReviewTools({ artifacts, configManifest, audience }: Pick<ReviewToolsOptions, 'artifacts' | 'configManifest' | 'audience'>): ReviewToolDefinition[] {
  if (configManifest.version !== 2 || !/^[a-f0-9]{64}$/.test(configManifest.configHash)) throw new Error('Unsupported stored tool manifest.');
  const tools: ReviewToolDefinition[] = [], names = new Set<string>();
  for (const artifact of artifacts) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(artifact.id) || !Object.hasOwn(configManifest.artifacts, artifact.id)) throw new Error('Invalid Artifact identifier.');
    const registered = configManifest.artifacts[artifact.id].views[audience === 'agent' ? 'agentTools' : 'humanTools'] ?? {};
    for (const [key, definition] of Object.entries(registered)) {
      const meta = metadata(definition.metadata), name = `${key}_${artifact.id}`;
      if (names.has(name)) throw new Error('Artifact tool names collide.');
      names.add(name);
      tools.push({ name, artifactId: artifact.id, operation: key, description: meta.description.replaceAll('{artifactName}', () => artifact.id), inputSchema: meta.inputSchema, metadata: meta,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } });
    }
  }
  return tools;
}

/** Validate the existing ancestor before creating any output directories. */
export async function externalDirectory(root: string, directory: string): Promise<string> {
  const target = resolve(directory);
  let ancestor = target;
  for (;;) {
    const actual = await realpath(ancestor).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (actual !== undefined) {
      if (within(root, resolve(actual, relative(ancestor, target)))) throw new Error('Tool output must be outside reviewed input.');
      break;
    }
    ancestor = dirname(ancestor);
  }
  await mkdir(target, { recursive: true });
  const actual = await realpath(target);
  if (within(root, actual)) throw new Error('Tool output must be outside reviewed input.');
  return actual;
}

async function executable(command: string, cwd: string, workspace: string): Promise<string> {
  if (command === 'node') return process.execPath;
  const candidates: string[] = [];
  if (isAbsolute(command) || /[\\/]/.test(command)) candidates.push(resolve(cwd, command));
  else {
    for (let current = cwd; within(workspace, current); current = dirname(current)) {
      candidates.push(join(current, 'node_modules', '.bin', command));
      if (current === workspace) break;
    }
    candidates.push(...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, command)));
  }
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); if ((await lstat(await realpath(candidate))).isFile()) return candidate; } catch { /* Try the next declared search location. */ }
  }
  throw Object.assign(new Error('The registered script executable is unavailable.'), { code: 'ENOENT' });
}

function toolEnvironment(outputDir: string, temporary: string): NodeJS.ProcessEnv {
  const names = ['PATH', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];
  return { ...Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]])),
    HOME: temporary, USERPROFILE: temporary, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    XDG_CACHE_HOME: join(temporary, 'cache'), CARGO_TARGET_DIR: join(outputDir, 'cargo-target'),
    CCDD_OUTPUT_DIR: outputDir, CCDD_TMP_DIR: temporary };
}

async function normalizeResult(value:unknown,meta:ToolMetadata,outputDir:string):Promise<ToolResult>{
  if (object(value) && value.isError === true) {
    if (Object.keys(value).some(key => !['isError', 'content'].includes(key)) || !Array.isArray(value.content) || value.content.length !== 1) throw new Error('Invalid author-controlled tool error.');
    const block = value.content[0];
    if (!object(block) || Object.keys(block).some(key => !['type', 'text'].includes(key)) || block.type !== 'text' || typeof block.text !== 'string' || !block.text.trim() || Buffer.byteLength(block.text) > 65536) throw new Error('Invalid author-controlled tool error.');
    return { isError: true, content: [{ type: 'text', text: block.text }] };
  }
  if(!object(value)||Object.keys(value).some(key=>!['content','observation'].includes(key))||!Array.isArray(value.content)||!value.content.length||value.content.length>32)throw new Error('Tool result must contain bounded content blocks.');
  const result:ToolResult={content:[]};
  for(const block of value.content){
    if(!object(block)||!meta.resultKinds.includes(block.type))throw new Error('Tool returned an undeclared content kind.');
    if(block.type==='text'){
      if(typeof block.text!=='string'||Buffer.byteLength(block.text)>65536)throw new Error('Tool text exceeds 64 KiB.');
      result.content.push({type:'text',text:block.text});
    }else if(block.type==='json'){
      const data=jsonCopy(block.data);if(Buffer.byteLength(JSON.stringify(data))>524288)throw new Error('Tool JSON content exceeds 512 KiB.');
      result.content.push({type:'json',data});
    }else if(block.type==='launch'){
      if(block.launched!==true)throw new Error('Invalid launcher result.');result.content.push({type:'launch',launched:true});
    }else if(block.type==='image'){
      if(!['image/png','image/jpeg','image/webp'].includes(block.mimeType))throw new Error('Unsupported image MIME type.');
      let bytes:Buffer;
      if(typeof block.path==='string'){
        const imageRoot=await realpath(outputDir),candidate=resolve(outputDir,block.path);
        if(!within(imageRoot,candidate))throw new Error('Image is outside the tool output directory.');
        const path=await scopedPath(imageRoot,relative(imageRoot,candidate).split(sep).join('/'));
        const info=await lstat(path);if(!info.isFile()||info.size>4*1024*1024)throw new Error('Image exceeds 4 MiB or is not a file.');
        bytes=await readFile(path);
      }else if(typeof block.data==='string'&&block.data.length<=5600000&&/^[A-Za-z0-9+/]*={0,2}$/.test(block.data))bytes=Buffer.from(block.data,'base64');
      else throw new Error('Image requires an output path or bounded base64 data.');
      if(!bytes.length||bytes.length>4*1024*1024)throw new Error('Invalid image size.');
      const valid=block.mimeType==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):block.mimeType==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
      if(!valid)throw new Error('Image bytes do not match declared MIME type.');
      result.content.push({type:'image',data:bytes.toString('base64'),mimeType:block.mimeType});
    }
  }
  if(value.observation!==undefined){
    if(meta.observation!=='content'||!object(value.observation)||!['content','empty'].includes(value.observation.kind)||Object.keys(value.observation).some(key=>!['kind','detail'].includes(key))||value.observation.detail!==undefined&&(typeof value.observation.detail!=='string'||value.observation.detail.length>2000))throw new Error('Invalid content observation.');
    const observed=result.content.some(block=>block.type==='image'||block.type==='json'||block.type==='text'&&(block.text.length>0||value.observation.kind==='empty'));
    if(!observed)throw new Error('Launching a program alone is not a content observation.');
    result.observation={kind:value.observation.kind,...(value.observation.detail===undefined?{}:{detail:value.observation.detail})};
  }
  return result;
}

export async function toToolContent(result:unknown):Promise<Array<{type:'text';text:string}|{type:'image';data:string;mimeType:string}>>{
  if(!object(result)||!Array.isArray(result.content))return [{type:'text',text:JSON.stringify(result)}];
  return result.content.map((block:any)=>{
    if(block.type==='image'&&typeof block.data==='string')return {type:'image' as const,data:block.data,mimeType:block.mimeType};
    return {type:'text' as const,text:block.type==='text'?block.text:JSON.stringify(block.type==='json'?block.data:{kind:'launch',launched:block.launched})};
  });
}



export async function createReviewTools(options: ReviewToolsOptions): Promise<ReviewToolRegistry> {
  const { configManifest, audience, signal, onCall } = options;
  signal?.throwIfAborted();
  const root = await realpath(options.worktreePath), { config } = await readWorkspaceConfig(root, signal);
  const mismatch = () => Object.assign(new Error('Recorded Artifact tools do not match the snapshot configuration.'), { code: 'WORKSPACE_ARTIFACT_MISMATCH' });
  if (!matchesToolManifest(config, configManifest)) throw mismatch();
  const artifacts = structuredClone(options.artifacts);
  for (const { id, ...definition } of artifacts) if (!Object.hasOwn(config.artifacts, id) || !isDeepStrictEqual(definition, config.artifacts[id])) throw mismatch();
  if (options.criticId !== undefined) {
    const critic = config.critics.find(value => value.id === options.criticId);
    if (!critic || critic.profile.kind !== audience || !isDeepStrictEqual(resolveArtifactScope(config.artifacts, [critic.target, ...critic.deps]).artifacts, artifacts)) throw mismatch();
  }
  const tools = describeReviewTools({ artifacts, configManifest, audience }), recorded: ReviewToolCall[] = [];
  const base = await externalDirectory(root, options.runDir ?? await mkdtemp(join(tmpdir(), 'ccdd-tools-')));
  const outputDir = await mkdtemp(join(base, 'tool-output-'));
  const scope: ArtifactScope = Object.fromEntries(await Promise.all(artifacts.map(async artifact => [artifact.id, {
    path: await scopedPath(root, artifact.path), children: structuredClone(artifact.children), mounts: structuredClone(artifact.mounts),
  }])));
  const controller = new AbortController(), active = new Set<Promise<ToolResult>>();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let closed = false;
  const find = (name: string) => { const tool = tools.find(value => value.name === name); if (!tool) throw new Error('Unknown registered Artifact tool.'); return tool; };
  const args = (name: string, value: unknown) => validateArguments(find(name).inputSchema, value);
  const definition = (tool: ReviewToolDefinition) => config.artifacts[tool.artifactId].views[audience === 'agent' ? 'agentTools' : 'humanTools']![tool.operation];
  const invoke = async (tool: ReviewToolDefinition, actual: Record<string, unknown>): Promise<{ result: ToolResult; call: ReviewToolCall }> => {
    controller.signal.throwIfAborted();
    const cwd = scope[tool.artifactId].path, script = definition(tool).script;
    const command = await executable(script.command, cwd, root);
    const callDir = await mkdtemp(join(outputDir, 'call-')), temporary = join(callDir, '.tmp');
    await mkdir(temporary);
    const request: ScriptToolRequest = { version: 1, context: { artifactId: tool.artifactId, artifactPath: cwd, outputDir: callDir, tmpDir: temporary, scope }, args: actual };
    let processResult;
    try {
      processResult = await runProcess(command, script.args, { cwd, input: JSON.stringify(request), env: toolEnvironment(callDir, temporary), signal: controller.signal,
        timeoutMs: tool.metadata.timeoutMs ?? 120000, maxOutputBytes: 16 * 1024 * 1024 });
    } catch (error) {
      controller.signal.throwIfAborted();
      throw Object.assign(new Error('Artifact script execution failed.', { cause: error }), { code: error instanceof Error && error.message.startsWith('Execution timed out') ? 'ARTIFACT_TOOL_TIMEOUT' : 'ARTIFACT_TOOL_FAILED' });
    }
    if (processResult.exitCode !== 0) throw Object.assign(new Error('Artifact script returned a nonzero exit status.'), { code: 'ARTIFACT_TOOL_FAILED' });
    let result: ToolResult;
    try {
      if (processResult.outputTruncated) throw new Error('Tool result exceeds its output limit.');
      result = await normalizeResult(JSON.parse(processResult.stdout), tool.metadata, callDir);
    } catch (error) { throw new ToolResultError(error); }
    controller.signal.throwIfAborted();
    const call: ReviewToolCall = { name: tool.name, arguments: actual, at: new Date().toISOString(), ...(result.isError ? { isError: true } : {}), observation: { artifactId: tool.artifactId, operation: tool.operation, ...result.observation } };
    await onCall?.(structuredClone(call));
    return { result, call };
  };
  return { tools, get toolCalls() { return structuredClone(recorded); }, outputDir, validateArguments: args,
    async call(name, value = {}) {
      if (closed) return Promise.reject(new Error('Artifact tool registry is closed.'));
      const tool = find(name), actual = args(name, value);
      const startedAt = new Date().toISOString(), started = performance.now();
      const task = (async () => {
        const attempt = await invoke(tool, actual).then(value => ({ ok: true as const, ...value }), error => ({ ok: false as const, error: error as unknown }));
        const diagnostic: ToolExecutionDiagnostic = { name: tool.name, artifactId: tool.artifactId, operation: tool.operation, startedAt, durationMs: performance.now() - started, outcome: attempt.ok && !attempt.result.isError ? 'success' : 'error', ...responseBytes(attempt.ok ? attempt.result : undefined) };
        if (options.onExecution) await bestEffortDiagnostic(() => options.onExecution!(diagnostic));
        if (!attempt.ok) throw attempt.error;
        // Optional telemetry cannot withhold successfully observed content.
        recorded.push(structuredClone(attempt.call));
        return attempt.result;
      })();
      active.add(task); task.then(() => active.delete(task), () => active.delete(task));
      return task;
    },
    async preflight({ toolName } = {}) {
      if (toolName) find(toolName);
      return Promise.all(tools.filter(tool => !toolName || tool.name === toolName).map(async tool => {
        try {
          controller.signal.throwIfAborted();
          await access(scope[tool.artifactId].path, constants.R_OK);
          await executable(definition(tool).script.command, scope[tool.artifactId].path, root);
          return { toolName: tool.name, artifactId: tool.artifactId, ok: true, message: 'Artifact folder and script executable are available; script not executed.' };
        } catch (error) { return { toolName: tool.name, artifactId: tool.artifactId, ok: false, ...safeToolFailure(error) }; }
      }));
    },
    async close() { closed = true; controller.abort(); signal?.removeEventListener('abort', abort); await Promise.allSettled([...active]); },
  };
}
