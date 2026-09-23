import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// A small standard-protocol script with no SDK or Provider dependency.
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { version, context, args } = JSON.parse(input);
if (version !== 1) throw new Error('Unsupported request version.');
const bytes = await readFile(join(context.artifactPath, process.argv[2]));
if (bytes.length > 1024 * 1024) throw new Error('This example accepts files up to 1 MiB.');
const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
if (text.includes('\0')) throw new Error('This example accepts text, not binary data.');
const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const selected = lines.slice(args.startLine - 1, args.startLine - 1 + args.lineCount);
const content = selected.join('');
if (Buffer.byteLength(content) > 64 * 1024) throw new Error('Select a smaller line range.');
process.stdout.write(JSON.stringify({
  content: [{ type: 'json', data: { content, startLine: args.startLine, lineCount: selected.length, totalLines: lines.length } }],
  ...(selected.length ? { observation: { kind: 'content' } } : lines.length === 0 ? { observation: { kind: 'empty' } } : {}),
}));
