import { AsyncLocalStorage } from 'node:async_hooks';
export interface ExecutionScope {
  runtimeRoot: string;
  declaredPaths: string[];
  trackChild(pid: number): () => void;
}
export const executionScope = new AsyncLocalStorage<ExecutionScope>();
