import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactViewer, createArtifactTools } from '../artifacts/index.mjs';
import { runProcess } from './process.mjs';

const MCP_SERVER = fileURLToPath(new URL('../artifacts/mcp-server.mjs', import.meta.url));

export function diagnosticError(code, message, remedy) {
  return Object.assign(new Error(message), { code, remedy });
}

const diagnoses = {
  AUTHENTICATION_FAILED: ['Provider가 인증 오류를 반환했습니다.', '이 CCDD 프로세스를 실행하는 사용자로 Codex에 다시 로그인한 뒤 doctor를 재실행하세요.'],
  MODEL_ACCESS_FAILED: ['Provider가 요청한 모델 또는 reasoning 설정을 거부했습니다.', 'Critic의 model·reasoning 설정과 현재 계정의 접근 권한을 확인하세요.'],
  ACCESS_DENIED: ['Provider가 접근 거부를 반환했습니다.', '현재 계정의 조직 정책과 Provider 접근 권한을 확인하세요.'],
  RATE_LIMITED: ['Provider가 사용량 제한 오류를 반환했습니다.', 'Provider의 사용량·할당량을 확인한 뒤 다시 진단하세요.'],
  MCP_UNAVAILABLE: ['Provider가 Artifact MCP 연결 실패를 보고했습니다.', 'Node 실행과 CCDD 설치 파일 접근 권한을 확인하고 doctor를 재실행하세요.'],
  PROVIDER_CONNECTION_FAILED: ['Provider 연결 과정에서 네트워크 오류가 보고되었습니다.', '네트워크·프록시·Provider 서비스 연결을 확인한 뒤 다시 진단하세요.'],
  PROVIDER_EXECUTION_FAILED: ['Codex provider failed: 실제 Provider 실행을 완료하지 못했습니다. 원인을 특정할 수 없습니다.', '현재 실행 계정의 인증, 모델 권한, Provider 연결과 Artifact MCP 설정을 확인하세요.'],
};

// Raw events and stderr never leave this classifier or get written to disk. Only
// known diagnostic categories from error records are retained, never model text.
function errorClassifier() {
  const pending = { stdout: '', stderr: '' };
  const categories = new Set();
  function inspect(stream, line) {
    let message;
    if (stream === 'stdout') {
      try {
        const event = JSON.parse(line);
        if (event.type === 'error') message = event.message ?? event.error?.message;
        if (event.type === 'turn.failed') message = event.error?.message;
      } catch {}
    } else if (/\bERROR\b|mcp startup:.*failed|MCP.*(?:failed|error)/i.test(line)) message = line;
    if (typeof message !== 'string') return;
    if (/\b401\b|unauthorized|authentication (?:failed|required)|not authenticated|(?:refresh|access) token.*(?:expired|invalid)|please (?:log|sign) in|login required/i.test(message)) categories.add('AUTHENTICATION_FAILED');
    else if (/model_not_found|model[^\n]{0,160}(?:not supported|not found|does not exist|do not have access|not available)|(?:unsupported|invalid)[^\n]{0,40}reasoning|reasoning[^\n]{0,80}(?:not supported|invalid|unsupported)/i.test(message)) categories.add('MODEL_ACCESS_FAILED');
    else if (/\b403\b|forbidden|access denied/i.test(message)) categories.add('ACCESS_DENIED');
    else if (/\b429\b|rate.limit|usage limit|quota.*exceed/i.test(message)) categories.add('RATE_LIMITED');
    else if (/mcp[^\n]{0,200}(?:failed|error|timeout|timed out)|(?:failed|unable) to.*mcp/i.test(message)) categories.add('MCP_UNAVAILABLE');
    else if (/connection (?:refused|reset|failed)|dns|name resolution|network (?:unreachable|error)|error sending request|TLS|certificate.*(?:invalid|failed)/i.test(message)) categories.add('PROVIDER_CONNECTION_FAILED');
  }
  return {
    collect(stream, bytes) {
      // Bound each pending line and ignore excess rather than retaining raw streams.
      pending[stream] = (pending[stream] + bytes.toString('utf8')).slice(-16_384);
      const lines = pending[stream].split('\n');
      pending[stream] = lines.pop();
      for (const line of lines) inspect(stream, line);
    },
    failure(exitCode, exitSignal) {
      for (const stream of ['stdout', 'stderr']) inspect(stream, pending[stream]);
      const code = categories.size === 1 ? [...categories][0] : 'PROVIDER_EXECUTION_FAILED';
      const [message, remedy] = diagnoses[code];
      return diagnosticError(code, `${message} (exit ${exitCode ?? exitSignal})`, remedy);
    },
  };
}

/** Same invocation, sandbox and scoped MCP adapter for real reviews and doctor. */
export async function invokeCodex({ codexPath, request, worktreePath, runDir, schema, makePrompt, signal, onEvent = () => {}, spawnImpl }) {
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const viewer = await createArtifactViewer({ worktreePath, artifacts: request.artifacts, artifactTypes: request.artifactTypes });
  const tools = createArtifactTools(viewer).tools;
  const manifestPath = resolve(runDir, 'artifact-tools.json');
  const schemaPath = resolve(runDir, 'result-schema.json');
  const resultPath = resolve(runDir, 'provider-result.json');
  const auditPath = resolve(runDir, 'artifact-calls.jsonl');
  await writeFile(manifestPath, JSON.stringify({ worktreePath: resolve(worktreePath), artifacts: request.artifacts, artifactTypes: request.artifactTypes, auditPath }), { mode: 0o600 });
  await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
  await writeFile(auditPath, '', { mode: 0o600 });
  await writeFile(resultPath, '', { mode: 0o600 });
  await onEvent({ type: 'artifact.tools.ready', tools: tools.map(x => ({ name: x.name, description: x.description })) });
  const config = [
    'approval_policy="never"', 'web_search="disabled"', 'project_doc_max_bytes=0', 'hide_agent_reasoning=true',
    `model_reasoning_effort=${JSON.stringify(request.profile.reasoning ?? 'medium')}`,
    `mcp_servers.ccdd_artifacts.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.ccdd_artifacts.args=${JSON.stringify([MCP_SERVER, manifestPath])}`,
    'mcp_servers.ccdd_artifacts.startup_timeout_sec=20', 'mcp_servers.ccdd_artifacts.tool_timeout_sec=30', 'mcp_servers.ccdd_artifacts.required=true',
    'features.skip_host_skill_discovery=true',
  ];
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--json', '--model', request.profile.model, '--cd', worktreePath, '--output-schema', schemaPath, '--output-last-message', resultPath];
  for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'browser_use', 'computer_use', 'multi_agent', 'skill_search', 'memories', 'view_image', 'image_generation']) args.push('--disable', feature);
  for (const entry of config) args.push('-c', entry);
  args.push('-');
  const classifier = errorClassifier();
  let run;
  try {
    run = await runProcess(codexPath, args, { cwd: worktreePath, env: process.env, input: makePrompt({ viewer, tools }), signal, timeoutMs: request.profile.timeoutMs ?? 240_000, capture: false, onOutput: classifier.collect, spawnImpl });
  } catch (error) {
    if (/timed out/.test(error.message)) throw diagnosticError('PROVIDER_TIMEOUT', error.message, 'Provider와 Artifact MCP 연결을 확인하세요. 정상 연결이 느린 경우 Critic의 timeoutMs를 조정하세요.');
    if (/aborted/.test(error.message)) throw diagnosticError('ABORTED', error.message, '진단 또는 리뷰가 취소되었습니다. 필요하면 다시 실행하세요.');
    if (['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code)) throw diagnosticError('PROVIDER_NOT_EXECUTABLE', 'Codex 실행 파일을 시작할 수 없습니다.', 'Codex 설치 경로와 실행 권한을 확인하세요.');
    throw diagnosticError('PROVIDER_EXECUTION_FAILED', 'Codex 프로세스를 실행할 수 없습니다.', 'Codex 설치, 실행 권한과 호스트 환경을 확인하세요.');
  }
  if (run.exitCode !== 0) throw classifier.failure(run.exitCode, run.exitSignal);
  let final;
  try { final = JSON.parse(await readFile(resultPath, 'utf8')); }
  catch { throw diagnosticError('INVALID_PROVIDER_RESULT', 'Codex did not return valid final JSON', 'Provider가 요구된 구조의 최종 응답을 반환하는지 확인하세요.'); }
  const audit = (await readFile(auditPath, 'utf8')).trim();
  const toolCalls = audit ? audit.split('\n').map(line => { const { name, arguments: args } = JSON.parse(line); return { name, arguments: args }; }) : [];
  for (const call of toolCalls) await onEvent({ type: 'artifact.tool.called', ...call });
  return { final, toolCalls };
}
