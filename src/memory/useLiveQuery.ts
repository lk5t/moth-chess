// Reactive IndexedDB queries (Dexie liveQuery) as a React hook: re-renders when the queried tables change.
import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';

export function useLiveQuery<T>(query: () => Promise<T>, deps: unknown[], initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const sub = liveQuery(query).subscribe({ next: (v) => setValue(v), error: () => { /* storage unavailable */ } });
    return () => sub.unsubscribe();
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return value;
}
