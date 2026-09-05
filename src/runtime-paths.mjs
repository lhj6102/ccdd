import {createRequire} from 'node:module';

// Resolve through Node's package lookup, including hoisted npm installations.
export const bundledCodexPath=createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
