import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const textExtensions = new Set(['.md', '.ts', '.mts', '.mjs', '.cjs', '.json', '.jsonc', '.vue', '.html', '.css', '.yml', '.yaml', '.txt']);
const paths = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))];
const failures = [];
let checked = 0;

for (const path of paths) {
  if (!textExtensions.has(extname(path))) continue;
  let content;
  try { content = await readFile(join(root, path), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  checked++;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (/\p{Script=Hangul}/u.test(line)) failures.push(`${path}:${index + 1}`);
  }
}

if (failures.length) {
  console.error('Use English for repository text. Preserve intentional Unicode test data with escapes.');
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`English language check passed (${checked} text files).`);
}
