import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  BACKGROUND_CONTEXT, createReadTool, err, ExecutionError, FileError, ok,
  type AgentHarnessToolInvocation, type Context, type ExecutionEnv, type Result,
} from '@earendil-works/pi-agent-core';
import { imageContent, MAX_IMAGE_BYTES } from './image-result.js';
import { internalPath, objectArguments, scopedTarget } from './reader.js';

/** Pi receives one virtual file, never a workspace path or an unrestricted Node execution environment. */
function imageEnvironment(root: string, directory: boolean, path: string): ExecutionEnv {
  const virtualPath = '/ccdd-image';
  const checkPath = (candidate: string): void => {
    if (candidate !== virtualPath) throw new Error('Pi image read is outside the bound Artifact');
  };
  const attempt = async <T>(context: Context, operation: () => Promise<T>): Promise<Result<T, FileError>> => {
    try {
      context.abortSignal?.throwIfAborted();
      const result = await operation();
      context.abortSignal?.throwIfAborted();
      return ok(result);
    } catch (error) {
      return err(new FileError(context.abortSignal?.aborted ? 'aborted' : 'invalid', error instanceof Error ? error.message : 'Image read failed'));
    }
  };
  const disabled = async (): Promise<Result<never, FileError>> => err(new FileError('not_supported', 'Only the bound image read is available'));
  return {
    cwd: '/',
    absolutePath: (candidate, context) => attempt(context, async () => { checkPath(candidate); return virtualPath; }),
    exists: (candidate, context) => attempt(context, async () => { checkPath(candidate); await scopedTarget(root, directory, path); return true; }),
    readBinaryFile: (candidate, context) => attempt(context, async () => {
      checkPath(candidate);
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
          context.abortSignal?.throwIfAborted();
          const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (!length || length > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 4 MiB limit or contains no data');
        return bytes.subarray(0, length);
      } finally { await file.close(); }
    }),
    joinPath: disabled, readTextFile: disabled, readTextLines: disabled,
    writeFile: disabled, appendFile: disabled, renameFile: disabled, fileInfo: disabled,
    listDir: disabled, canonicalPath: disabled, createDir: disabled, remove: disabled,
    createTempDir: disabled, createTempFile: disabled,
    exec: async () => err(new ExecutionError('shell_unavailable', 'Image reads cannot execute shell commands')),
    cleanup: async () => {},
  };
}

/** Internal CLI adapter. The public tool remains a CCDD definition and creates no Agent or Provider session. */
export async function imageRequest(input: unknown): Promise<ReturnType<typeof imageContent>> {
  const request = objectArguments(input, ['operation', 'root', 'directory', 'args']);
  if (request.operation !== 'view_image' || typeof request.root !== 'string' || typeof request.directory !== 'boolean') throw new Error('Invalid image request');
  const args = objectArguments(request.args, ['path']);
  const path = internalPath(args.path);
  if (request.directory && !path) throw new Error('Viewing an image in a directory Artifact requires an internal file path');
  if (!request.directory && Object.hasOwn(args, 'path')) throw new Error('A file Artifact image view does not accept path');
  const env = imageEnvironment(request.root, request.directory, path);
  const invocation: AgentHarnessToolInvocation = {
    invocationId: 'ccdd-image', operationId: 'view_image', turnId: 'ccdd-image',
    async getMemo() { return undefined; },
    async setMemo() { throw new Error('Image reads do not use session state'); },
  };
  const result = await createReadTool({ autoResizeImages: false }).execute('ccdd-image', { path: '/ccdd-image' }, () => {}, { env }, invocation, BACKGROUND_CONTEXT);
  const images = result.content.filter(block => block.type === 'image');
  if (images.length !== 1) throw new Error('Pi read did not return a supported image. view_image requires PNG, JPEG or WebP; text, GIF, BMP and animated PNG are not supported');
  return imageContent(images[0]);
}
