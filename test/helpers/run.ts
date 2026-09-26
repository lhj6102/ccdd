import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { createBroker, RunView } from '../../src/broker/index.js';

/** Start a real worker and return when execution finishes or reaches a monitored Human wait. */
export async function runUntilSettled(broker: ReturnType<typeof createBroker<'full'>>, id: string): Promise<RunView> {
  const running = broker.getRun(id)?.owner ? undefined : broker.run(id);
  const waiting = (async () => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const run = broker.getRun(id);
      assert.ok(run);
      if (run.status === 'WAITING_HUMAN' && run.requests.every(request =>
        ['BLOCKED', 'GREEN', 'RED', 'ERROR'].includes(request.status) || request.status === 'WAITING_HUMAN' && request.notifiedAt)) {
        assert.ok(run.owner, 'The worker must keep monitoring while Humans review.');
        return run;
      }
      if (['GREEN', 'RED', 'ERROR', 'INCOMPLETE'].includes(run.status) && !run.owner) return run;
      await delay(10);
    }
    throw new Error('The review did not settle.');
  })();
  await (running ? Promise.race([running, waiting]) : waiting);
  const settled = broker.getRun(id);
  assert.ok(settled);
  return settled;
}
