import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { imageContent, MAX_IMAGE_BYTES } from './image-result.js';
import { internalPath, objectArguments, scopedTarget } from './reader.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Exact bytes: an 'ascii' decode would clear the high bit and accept corrupted markers.
const marker = (bytes: Buffer, offset: number, text: string): boolean => bytes.subarray(offset, offset + text.length).equals(Buffer.from(text, 'latin1'));

/** An animation control chunk before the first image data marks an animated PNG. */
function animatedPng(bytes: Buffer): boolean {
  for (let offset = PNG_SIGNATURE.length; offset + 8 <= bytes.length;) {
    if (marker(bytes, offset + 4, 'acTL')) return true;
    if (marker(bytes, offset + 4, 'IDAT')) return false;
    const next = offset + 12 + bytes.readUInt32BE(offset);
    if (next <= offset || next > bytes.length) return false;
    offset = next;
  }
  return false;
}

/** The format is detected from the file content, never from its name: PNG (not animated), JPEG or WebP. */
export function imageMimeType(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[3] !== 0xf7) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const header = bytes.length >= 16 && bytes.readUInt32BE(8) === 13 && marker(bytes, 12, 'IHDR');
    return header && !animatedPng(bytes) ? 'image/png' : undefined;
  }
  if (marker(bytes, 0, 'RIFF') && marker(bytes, 8, 'WEBP')) return 'image/webp';
  return undefined;
}

/** Read one bound regular file without following a final symlink, with a fixed upper bound. */
async function readImage(root: string, directory: boolean, path: string): Promise<Buffer> {
  const target = await scopedTarget(root, directory, path);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Viewing an image requires a regular file');
    if (!info.size || info.size > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 4 MiB limit or contains no data');
    // A fixed upper bound also catches a file growing after stat without an unbounded readFile allocation.
    const bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (!length || length > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 4 MiB limit or contains no data');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

/** Internal CLI adapter. The public tool remains a CCDD definition and creates no Agent or Provider session. */
export async function imageRequest(input: unknown): Promise<ReturnType<typeof imageContent>> {
  const request = objectArguments(input, ['operation', 'root', 'directory', 'args']);
  if (request.operation !== 'view_image' || typeof request.root !== 'string' || typeof request.directory !== 'boolean') throw new Error('Invalid image request');
  const args = objectArguments(request.args, ['path']);
  const path = internalPath(args.path);
  if (request.directory && !path) throw new Error('Viewing an image in a directory Artifact requires an internal file path');
  if (!request.directory && Object.hasOwn(args, 'path')) throw new Error('A file Artifact image view does not accept path');
  const bytes = await readImage(request.root, request.directory, path), mimeType = imageMimeType(bytes);
  if (!mimeType) throw new Error('The file is not a supported image. view_image requires PNG, JPEG or WebP; text, GIF, BMP and animated PNG are not supported');
  return imageContent({ type: 'image', data: bytes.toString('base64'), mimeType });
}
