import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const { context, args } = JSON.parse(input);
const path = resolve(context.artifactPath, args.path), sub = relative(context.artifactPath, path);
if (isAbsolute(sub) || sub.startsWith('..')) throw new Error('Path must remain inside the Artifact.');
process.stdout.write(JSON.stringify({ content: [{ type: 'text', text: await readFile(path, 'utf8') }], observation: { kind: 'content' } }));
