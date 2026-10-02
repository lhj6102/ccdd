import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
let text = '';
for await (const chunk of process.stdin) text += chunk;
const { version, context, args } = JSON.parse(text);
if (version !== 1) throw new Error('Unsupported request version.');
// Every instance shares this folder and script; each one names its own material.
const [file] = context.scope[context.artifactId].family?.material ?? [];
if (!file) throw new Error('This view serves Artifact family instances.');
const scenario = JSON.parse(await readFile(join(context.artifactPath, file), 'utf8'));
if (!Array.isArray(scenario.details) || !Array.isArray(scenario.criteria)) throw new Error('Invalid scenario.');
const data = process.argv[2] === 'overview'
  ? { name: scenario.name, objective: scenario.objective, criteria: scenario.criteria, detailIds: scenario.details.map(item => item.id) }
  : scenario.details.find(item => item.id === args.id);
if (!data) throw new Error('Unknown scenario detail.');
process.stdout.write(JSON.stringify({ content: [{ type: 'json', data }], observation: { kind: 'content' } }));
