import { useState, useEffect } from "react";

/**
 * Unix seconds, ticking every 15s. Conversation rows derive their "41S / 2H /
 * 3D" age from it, so a chat opened an hour ago stops claiming to be "now".
 * The cadence is coarse on purpose — the labels only change by the minute at
 * best, and re-rendering the sidebar every second would be pure waste.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}
