/** Keep foreground preparation alive until its child processes and temporary output are cleaned up. */
export async function withCliCancellation<T>(message: string, prepare: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error(message));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { return await prepare(controller.signal); }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
