'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { TradeRow } from '@/lib/types';

/**
 * The simulated trades, newest first, polled while the tab is visible. `refreshKey` forces an immediate reload when
 * something that should change the list happened (a trade opened or closed), so a finished trade shows up at once
 * instead of after the next poll. Returns null until the first answer; keeps the last answer if a poll fails.
 */
export function useDemoTrades(limit = 40, everyMs = 6000, refreshKey = ''): { rows: TradeRow[] | null; failed: boolean } {
  const [rows, setRows] = useState<TradeRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const last = useRef('');
  const loadRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    const load = () => {
      api<{ trades: TradeRow[] }>('GET', `trades?mode=demo&limit=${limit}`)
        .then((r) => {
          if (!alive) return;
          setFailed(false);
          // keep the same array when nothing changed so memoised children do not re-render for nothing
          const sig = JSON.stringify(r.trades.map((t) => [t.id, t.status, t.exitTs, t.netPnl]));
          if (sig !== last.current) {
            last.current = sig;
            setRows(r.trades);
          }
        })
        .catch(() => alive && setFailed(true));
    };
    loadRef.current = load;
    load();
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, everyMs);
    const vis = () => {
      if (!document.hidden) load();
    };
    document.addEventListener('visibilitychange', vis);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [limit, everyMs]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    loadRef.current();
  }, [refreshKey]);

  return { rows, failed };
}
