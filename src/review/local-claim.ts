import type { Broker } from '../broker/index.js';
import { withCliCancellation } from '../cli-cancellation.js';

/** Keep the local CLI alive long enough to release Try Claim and stop its checks. */
export async function claimHumanFromCli(broker: Broker<'full'>, requestId: string, reviewerId: string, stderr: { write(value: string): unknown }) {
  return withCliCancellation('Human claim preparation cancelled.', async signal => {
    stderr.write('Try Claim: preparing the review input and checking the local environment.\n');
    return broker.claimHuman(requestId, reviewerId, { signal });
  });
}
