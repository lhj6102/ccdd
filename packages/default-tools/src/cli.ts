import { readerRequest } from './reader.js';

try {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.from(chunk);
    bytes += data.length;
    if (bytes > 64 * 1024) throw new Error('Reader request exceeded its limit');
    chunks.push(data);
  }
  const data = await readerRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
} catch (error) {
  // A single structured response distinguishes invalid input from process failures.
  process.stdout.write(`${JSON.stringify({ ok: false, message: error instanceof Error ? error.message : 'Reader execution failed' })}\n`);
}
