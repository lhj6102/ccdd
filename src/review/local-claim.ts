import type { Broker } from '../broker/index.js';

/** Keep the local CLI alive long enough to release Try Claim and stop its checks. */
export async function claimHumanFromCli(broker: Broker, requestId: string, reviewerId: string, stderr: { write(value: string): unknown }) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Human claim preparation cancelled.'));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    stderr.write('Try Claim: preparing the review input and checking the local environment.\n');
    return await broker.claimHuman(requestId, reviewerId, { signal: controller.signal });
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
