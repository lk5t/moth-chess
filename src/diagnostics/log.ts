// Local error log: a small ring buffer in chrome.storage.local. Never uploaded; shown in the Control
// Center and included in a diagnostic report only after the user reviews it.
import { kvGet, kvSet, kvSubscribe } from '@/storage/kv';
import { redact } from './redact';

export const ERROR_LOG_KEY = 'moth.errors.v1';
export const ERROR_LOG_MAX = 50;

export interface LogEntry { at: number; source: string; message: string; count: number }

let chain: Promise<unknown> = Promise.resolve();

/** Record an error. Identical consecutive messages are folded into one entry with a count. */
export function logError(source: string, message: string): Promise<void> {
  const msg = redact(String(message)).slice(0, 400);
  const run = chain.then(async () => {
    const list = ((await kvGet<LogEntry[]>(ERROR_LOG_KEY)) ?? []).filter((e) => e && typeof e.message === 'string');
    const last = list[list.length - 1];
    if (last && last.source === source && last.message === msg) { last.count++; last.at = Date.now(); }
    else list.push({ at: Date.now(), source, message: msg, count: 1 });
    await kvSet(ERROR_LOG_KEY, list.slice(-ERROR_LOG_MAX));
  });
  chain = run.catch(() => {});
  return run;
}

export async function readErrors(): Promise<LogEntry[]> {
  const v = await kvGet<LogEntry[]>(ERROR_LOG_KEY);
  return Array.isArray(v) ? v : [];
}
export const clearErrors = () => kvSet(ERROR_LOG_KEY, []);
export const subscribeErrors = (cb: (l: LogEntry[]) => void) => kvSubscribe(ERROR_LOG_KEY, (v) => cb(Array.isArray(v) ? (v as LogEntry[]) : []));
