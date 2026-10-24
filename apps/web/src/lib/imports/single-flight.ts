import { useRef } from "react";

/**
 * Re-entry guard for confirmed actions. React Query publishes `isPending` asynchronously, so two
 * clicks in the same tick can both pass an `isPending` check; the ref flips synchronously. Errors
 * are surfaced by the mutation's own `onError`, so they are swallowed here.
 */
export function useSingleFlight(): (run: () => Promise<unknown>) => void {
  const busy = useRef(false);
  return (run) => {
    if (busy.current) return;
    busy.current = true;
    void run()
      .catch(() => undefined)
      .finally(() => {
        busy.current = false;
      });
  };
}
