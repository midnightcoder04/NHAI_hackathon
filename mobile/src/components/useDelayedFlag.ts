import { useEffect, useState } from 'react';

/**
 * T078 / Constitution IV "200 ms feedback rule": returns `true` only once `active` has
 * stayed `true` for `delayMs`, so a loading indicator shown for a sub-200 ms async op
 * never flickers on screen. Resets to `false` immediately when `active` goes `false`.
 */
export function useDelayedFlag(active: boolean, delayMs = 200): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return shown;
}
