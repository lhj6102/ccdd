import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';

// Resolve through Node's package lookup, including hoisted npm installations.
export const bundledCodexPath=createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
export const packageVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
