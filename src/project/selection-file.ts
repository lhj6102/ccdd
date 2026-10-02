import { open } from 'node:fs/promises';

/** Explicit file input: JSON arrays or newline-delimited IDs; never fallback from malformed JSON. */
export function parseSelectionFile(text: string): string[] {
  text = text.replace(/^\uFEFF/, '');
  if (Buffer.byteLength(text) > 4 * 1024 ** 2) throw new Error('Selection file exceeds 4 MiB.');
  let input: unknown;
  if (text.trimStart().startsWith('[')) {
    try { input = JSON.parse(text); } catch { throw new Error('Selection file contains invalid JSON.'); }
  } else input = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!Array.isArray(input) || !input.length || input.length > 100000 || input.some(id => typeof id !== 'string' || !id || id.trim() !== id || /[\x00-\x20\x7F,]/.test(id))) {
    throw new Error('Selection file must contain 1–100000 nonempty IDs, as a JSON string array or one ID per line.');
  }
  // Preserve first occurrence/order. The normal project selection validates IDs and family names.
  return [...new Set(input as string[])];
}
export async function readSelectionFile(path: string): Promise<string[]> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4 * 1024 ** 2) throw new Error('Selection input must be a regular file no larger than 4 MiB.');
    // Read a bounded number of bytes even if a file is replaced or appended concurrently.
    const buffer = Buffer.alloc(4 * 1024 ** 2 + 1); let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null); if (!bytesRead) break; offset += bytesRead; }
    if (offset > 4 * 1024 ** 2) throw new Error('Selection file exceeds 4 MiB.');
    return parseSelectionFile(buffer.subarray(0, offset).toString('utf8'));
  } finally { await file.close(); }
}
