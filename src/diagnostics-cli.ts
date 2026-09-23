import { resolve } from 'node:path';
import { prepareDemo } from '../scripts/prepare-demo.js';
import { diagnoseProject } from './doctor/index.js';
import { diagnoseArtifactTools } from './artifacts/tool-check.js';
import { createExecutorRegistry } from './executors/index.js';
import { localContext, createLocalAlarmMethods } from './local.js';
import { startMonitor } from './monitor/server.js';
import type { PiOptions } from './executors/pi.js';

type Output = { write(value: string): unknown };
/** Explicit diagnostics share Project's folder model and never submit reviews. */
export async function diagnosticsMain(argv: string[], { stdout, stderr }: { stdout: Output; stderr: Output }): Promise<number> {
  const command = argv[0], options: Record<string, string | boolean> = {}, positional: string[] = [];
  const flags = new Set(['--json', '--execute', '--human-inbox']);
  const permitted: Record<string, string[]> = {
    doctor: ['--repo', '--state-dir', '--critic', '--pi-auth-file', '--codex-auth-file', '--human-inbox', '--timeout-ms', '--json'],
    tools: ['--repo', '--state-dir', '--artifact', '--for', '--tool', '--execute', '--args', '--json'],
    monitor: ['--repo', '--state-dir', '--port'], 'prepare-demo': ['--demo-dir'],
  };
  const print = (value: unknown) => stdout.write((typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n');
  try {
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i];
      if (!arg.startsWith('-')) { positional.push(arg); continue; }
      if (!permitted[command]?.includes(arg) || Object.hasOwn(options, arg)) throw new Error(`Unsupported or duplicate option: ${arg}`);
      if (flags.has(arg)) options[arg] = true;
      else { const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`); options[arg] = value; }
    }
    const get = (key: string) => typeof options[key] === 'string' ? options[key] as string : undefined;
    if (command === 'prepare-demo') { if (positional.length) throw new Error('prepare-demo accepts only --demo-dir.'); print(await prepareDemo({ ...(get('--demo-dir') ? { root: resolve(get('--demo-dir')!) } : {}) })); return 0; }
    if (command === 'monitor') {
      if (positional.length || get('--repo') && get('--state-dir')) throw new Error('monitor accepts either --repo or --state-dir.');
      const port = Number(get('--port') ?? 4318);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
      const stateDir = get('--repo') ? (await localContext({ repoPath: resolve(get('--repo')!) })).stateDir : get('--state-dir');
      const monitor = await startMonitor({ ...(stateDir ? { stateDirs: [resolve(stateDir)] } : {}), port });
      print(`CCDD monitor · ${monitor.url}`);
      await new Promise<void>((resolve, reject) => {
        const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); void monitor.close().then(resolve, reject); };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
      });
      return 0;
    }
    const context = await localContext({ repoPath: resolve(get('--repo') ?? process.cwd()), stateDir: get('--state-dir') });
    if (command === 'tools') {
      if (positional.length !== 1 || positional[0] !== 'check') throw new Error('Use tools check.');
      const audience = get('--for');
      if (audience !== undefined && audience !== 'agent' && audience !== 'human') throw new Error('--for must be agent or human.');
      const report = await diagnoseArtifactTools({ ...context, artifactId: get('--artifact'), audience, toolName: get('--tool'), execute: Boolean(options['--execute']), ...(get('--args') === undefined ? {} : { arguments: JSON.parse(get('--args')!) }) });
      print(report); return report.ok ? 0 : 1;
    }
    if (positional.length) throw new Error('doctor accepts named options only.');
    const piOptions: PiOptions = {}, authFile = get('--pi-auth-file') ?? process.env.CCDD_PI_AUTH_FILE, codexAuthFile = get('--codex-auth-file') ?? process.env.CCDD_CODEX_AUTH_FILE;
    if (authFile) piOptions.authFile = resolve(authFile);
    if (codexAuthFile) piOptions.codexAuthFile = resolve(codexAuthFile);
    const timeout = Number(get('--timeout-ms') ?? 900000);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86400000) throw new Error('Invalid timeout.');
    const executors = createExecutorRegistry({ piOptions, alarmMethods: createLocalAlarmMethods({ ...context, humanInbox: Boolean(options['--human-inbox']) }) });
    const report = await diagnoseProject({ ...context, criticId: get('--critic'), executors, signal: AbortSignal.timeout(timeout) });
    print(report); return report.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options['--json']) print({ error: message }); else stderr.write(message + '\n');
    return 2;
  }
}
