import type { ToolContent } from '@ccdd/core';

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_OUTPUT_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4096;
type ImageContent = Extract<ToolContent, { type: 'image'; data: string }>;

/** Check the CLI/Pi boundary before assigning a content observation. The Runner checks again. */
export function imageContent(value: unknown): ImageContent {
  if (!value || typeof value !== 'object') throw new Error('Pi read did not return a supported image');
  const image = value as Record<string, unknown>;
  if (image.type !== 'image' || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType as string)) {
    throw new Error('view_image requires a PNG, JPEG or WebP image; text, GIF, BMP and animated PNG are not supported');
  }
  if (typeof image.data !== 'string' || !image.data.length || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('Image exceeds the 4 MiB limit or contains no data');
  const bytes = Buffer.from(image.data, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== image.data) throw new Error('Invalid image data or image exceeds the 4 MiB limit');
  const valid = image.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : image.mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw new Error('Image bytes do not match the declared MIME type');
  return { type: 'image', data: image.data, mimeType: image.mimeType as ImageContent['mimeType'] };
}
