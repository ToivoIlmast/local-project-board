import { useCallback, useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

/**
 * One value in the address bar. What the page is looking at — a task, a panel — belongs in
 * the URL: reloading keeps it, and the back button does what it looks like it does.
 */
export function useSearchParam(name: string): [string | null, (value: string | null) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => new URLSearchParams(window.location.search).get(name),
    () => null,
  );

  const set = useCallback(
    (next: string | null) => {
      const params = new URLSearchParams(window.location.search);
      if (next === null) params.delete(name);
      else params.set(name, next);
      const search = params.toString();
      window.history.pushState({}, '', `${window.location.pathname}${search ? `?${search}` : ''}`);
      for (const listener of [...listeners]) listener();
    },
    [name],
  );

  return [value, set];
}
