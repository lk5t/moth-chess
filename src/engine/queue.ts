// Serialised access to the batch engine so concurrent background jobs queue instead of cancelling each other.
import type { EngineResult } from '@/types';
import { getBatchEngine } from './worker-transport';

let chain: Promise<unknown> = Promise.resolve();
let pendingJobs = 0;

export function queuedEvaluate(fen: string, depth: number, multiPv = 1, signal?: AbortSignal): Promise<EngineResult> {
  pendingJobs++;
  const job = chain.then(async () => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const h = getBatchEngine().analyse(fen, { depth, multiPv });
    const onAbort = () => h.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    try { return await h.result; } finally { signal?.removeEventListener('abort', onAbort); }
  });
  chain = job.catch(() => undefined).finally(() => { pendingJobs--; });
  return job;
}

export const batchQueueLength = () => pendingJobs;
