import { AsyncLocalStorage } from 'node:async_hooks';
/** Internal scope: diagnostic state is never ordinary review evidence. */
export const diagnosticScope = new AsyncLocalStorage<{ guard: string }>();
