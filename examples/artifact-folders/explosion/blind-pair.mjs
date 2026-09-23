import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { resolveScopePath } from '@ccdd/core';
let text = '';
for await (const chunk of process.stdin) text += chunk;
const { version, context } = JSON.parse(text);
if (version !== 1) throw new Error('Unsupported request version.');
const names = ['theme/theme.png', 'preview/preview.png'];
if (randomInt(2)) names.reverse();
const content = [];
for (const [index, name] of names.entries()) {
  const resolved = resolveScopePath(context.scope, context.artifactId, name);
  const bytes = await readFile(join(context.scope[resolved.artifactId].path, resolved.path));
  content.push({ type: 'text', text: index === 0 ? 'A' : 'B' }, { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' });
}
// Keep the mapping for the requester outside the input; never return it to the reviewer.
await writeFile(join(context.outputDir, 'pair-map.json'), JSON.stringify(names));
process.stdout.write(JSON.stringify({ content, observation: { kind: 'content' } }));
