export interface AdmissionRequest { requestId: string; runId: string; provider?: string; model?: string; kind: string }
export interface AdmissionLease { release(): void | Promise<void> }
/** A future machine-wide provider pool implements this same cancellable boundary. */
export interface Admission {
  acquire(request: AdmissionRequest, options: { signal: AbortSignal; waiting(reason: string): void }): Promise<AdmissionLease>;
}
/** FIFO local slots. Canceled waiters never consume or strand a slot. */
export function localAdmission(limit: number): Admission {
  let active = 0;
  const pending: { signal: AbortSignal; resolve: (lease: AdmissionLease) => void; reject: (error: unknown) => void; abort: () => void }[] = [];
  const drain = () => {
    while (active < limit && pending.length) {
      const waiter = pending.shift()!; waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal.aborted) { waiter.reject(waiter.signal.reason); continue; }
      active++; let released = false;
      waiter.resolve({ release() { if (released) return; released = true; active--; drain(); } });
    }
  };
  return { acquire(_request, { signal, waiting }) {
    signal.throwIfAborted();
    if (active >= limit || pending.length) waiting('Waiting for executor admission slot.');
    return new Promise((resolve, reject) => {
      const waiter = { signal, resolve, reject, abort: () => { const index = pending.indexOf(waiter); if (index >= 0) pending.splice(index, 1); reject(signal.reason); } };
      pending.push(waiter); signal.addEventListener('abort', waiter.abort, { once: true }); drain();
    });
  } };
}
