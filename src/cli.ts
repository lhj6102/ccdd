#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { main } from './project/cli.js';
export { main } from './project/cli.js';
export { launchWorker } from './worker-client.js';
export type { WorkerOptions } from './worker-client.js';
let entrypoint = false;
try { entrypoint = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (entrypoint) process.exitCode = await main();
