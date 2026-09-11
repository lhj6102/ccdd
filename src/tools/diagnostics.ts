export type ArtifactToolCheckStage = 'snapshot' | 'preflight' | 'execute' | 'normalize-result' | 'input-integrity';
export interface SafeToolFailure { code: string; message: string }

const failures: Record<string, string> = {
  ABORTED: 'Artifact tool diagnosis was cancelled.',
  WORKSPACE_CHANGED: 'The workspace changed during Artifact tool diagnosis.',
  WORKSPACE_CACHE_TAMPERED: 'The workspace changed during Artifact tool diagnosis.',
  WORKSPACE_ARTIFACT_MISMATCH: 'Recorded Artifact tools do not match the snapshot configuration.',
  ARTIFACT_TOOLS_UNAVAILABLE: 'A Critic references an Artifact with no tools for its reviewer kind. Register the corresponding agentTools or humanTools.',
  HUMAN_TOOL_TIMEOUT: 'The registered Human tool exceeded its configured time limit.',
  HUMAN_TOOL_UNAVAILABLE: 'The registered Human tool executable is unavailable.',
  HUMAN_TOOL_FAILED: 'The registered Human tool did not finish successfully.',
  ARTIFACT_TOOL_TIMEOUT: 'The registered Artifact tool exceeded its configured time limit.',
  ARTIFACT_TOOL_FAILED: 'The registered Artifact tool failed. Custom error text is withheld because it may contain credentials or environment values.',
  ARTIFACT_TOOL_RESULT_INVALID: 'The tool result must contain only bounded JSON values.',
  ARTIFACT_TOOL_PREFLIGHT_FAILED: 'The registered tool reported that its preflight check failed. Custom failure text is withheld because it may contain credentials or environment values.',
  ARTIFACT_TOOL_CLEANUP_FAILED: 'Artifact tool subprocess cleanup did not complete.',
  ENOENT: 'A required file or executable was not found.',
  EACCES: 'Access to a required file or executable was denied.',
  EPERM: 'A required filesystem or process operation was not permitted.',
  ENOTDIR: 'A required directory path is not a directory.',
  EISDIR: 'A required file path is a directory.',
  ENOSPC: 'No space is available for tool or workspace output.',
  EIO: 'A filesystem input/output operation failed.',
  ETIMEDOUT: 'A required operation timed out.',
};

// Only runner-owned validation messages cross this diagnostic boundary verbatim.
// Tool host exceptions are handled by code and fixed messages, never by their text.
const resultMessages = new Set([
  'Tool result must contain bounded content blocks.',
  'Tool returned an undeclared content kind.',
  'Tool text exceeds 64 KiB.',
  'Tool JSON content exceeds 512 KiB.',
  'Tool declarations and results must contain only JSON values.',
  'Tool JSON exceeds the supported size.',
  'Invalid launcher result.',
  'Unsupported image MIME type.',
  'Image is outside the tool output directory.',
  'Artifact path must be relative to its declared root.',
  'Artifact symlinks are not supported.',
  'Artifact path escapes its declared root.',
  'Image exceeds 4 MiB or is not a file.',
  'Image requires an output path or bounded base64 data.',
  'Invalid image size.',
  'Image bytes do not match declared MIME type.',
  'Invalid content observation.',
  'Launching a program alone is not a content observation.',
]);

/** Marks validation performed after a tool has returned, without exposing its result. */
export class ToolResultError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Invalid Artifact tool result.', { cause });
  }
}

export function safeToolFailure(error: unknown, aborted = false): SafeToolFailure {
  if (aborted) return { code: 'ABORTED', message: failures.ABORTED };
  if (error instanceof ToolResultError) {
    const cause = error.cause;
    if (cause instanceof Error && resultMessages.has(cause.message)) return { code: 'ARTIFACT_TOOL_RESULT_INVALID', message: cause.message };
    const failure = safeToolFailure(cause);
    return failure.code === 'ARTIFACT_TOOL_CHECK_FAILED' ? { code: 'ARTIFACT_TOOL_RESULT_INVALID', message: 'The returned Artifact tool content could not be validated.' } : failure;
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && Object.hasOwn(failures, code)) return { code, message: failures[code] };
  return { code: 'ARTIFACT_TOOL_CHECK_FAILED', message: 'Artifact tool diagnosis failed. Check the configuration, selected tool, scoped arguments and workspace access.' };
}

export function toolFailureStage(error: unknown, fallback: ArtifactToolCheckStage): ArtifactToolCheckStage {
  const code = safeToolFailure(error).code;
  if (code === 'WORKSPACE_CHANGED' || code === 'WORKSPACE_CACHE_TAMPERED') return 'input-integrity';
  if (error instanceof ToolResultError || code === 'ARTIFACT_TOOL_RESULT_INVALID') return 'normalize-result';
  return fallback;
}
