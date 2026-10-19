# Delta Exchange public market-data WebSocket: what the browser feed relies on

Written for `apps/web/lib/market`. Everything here is **public market data, no authentication, no secrets**.

**Verification status.** The Delta hosts (REST and WebSocket) are not reachable from the build sandbox. Nothing below was
exercised against the real exchange. "Documented" means "stated in the official docs source"; the code was verified only against
a fake WebSocket server / fake message streams (see the tests next to this file) and against the checksum examples printed in the docs.

## Sources (all read during development)

| Source | What it gave |
|---|---|
| `https://raw.githubusercontent.com/delta-exchange/slate/master/source/includes/_websocket_api.md` (Delta's official API documentation source, the same file the rendered docs are built from) | endpoints, subscribe/unsubscribe, heartbeat, every channel below, the order-book maintenance algorithm and the checksum algorithm |
| `.../source/includes/_changelog.md` | 17.04.26: the new public endpoint and the channel migration table; 14.10.26: final deprecation notice (31 Oct 2026) of the legacy `l1_orderbook`, `l2_orderbook`, `l2_update` channels |
| `.../source/includes/_general_information.md` | symbol format (`ETHUSD`, `MARK:ETHUSD`), `ETHUSD` is a `perpetual_futures` product |
| `docs/DELTA_API.md` and `packages/delta/src/ws.ts` in this repo | the server-side client already uses `enable_heartbeat`, 35 s silence rule, back-off + jitter |
| CCXT 4.5.88 and `delta-rest-client` 1.0.14 | REST only, no WebSocket information (cross-check not possible for the feed) |

## Endpoint

* **Documented**: public channels live on the **public endpoint**: production (India) `wss://public-socket.india.delta.exchange`;
  testnet `wss://socket-ind-pub.testnet.deltaex.org`. The older host `wss://socket.india.delta.exchange` is the *private/legacy*
  endpoint (authenticated channels, and the legacy public channels that die on 31 Oct 2026). The new channels (`ob_l1`, `ob_l2`,
  `ob_updates`, `trades`, `mark_price`, `candlesticks`, `ticker`, ...) are documented as "available on the new public api websocket endpoint".
* This is why the default URL in `protocol.ts` is `wss://public-socket.india.delta.exchange` and **not** `wss://socket.india.delta.exchange`
  (`docs/DELTA_API.md` lists the public one in its table; the private one is the second row there).
* **Documented limits**: 150 connections per 5 minutes per IP (HTTP 429 on the upgrade, wait 5-10 minutes); the server disconnects a
  connection with no activity for 60 s. A browser cannot read the 429 status of a failed upgrade, so the client simply backs off harder after
  repeated failed attempts (cap 30 s, 2 minutes after 6 failures in a row).
* **Not documented / inferred**: whether the public endpoint accepts a browser `Origin` that is not a Delta site. WebSockets are not subject to CORS,
  but a server may still refuse an unknown Origin. If it does, the page falls back to the backend quote (status "Delayed") and keeps retrying.
  Only opening the live dashboard in a real browser can confirm it.

## Messages we send

```jsonc
{"type":"enable_heartbeat"}                       // right after the socket opens (documented)
{"type":"subscribe","payload":{"channels":[       // documented format; symbols are required for every channel below
  {"name":"ob_l1","symbols":["ETHUSD"]},
  {"name":"ob_l2","symbols":["ETHUSD"]},
  {"name":"ob_updates","symbols":["ETHUSD"]},
  {"name":"trades","symbols":["ETHUSD"]},
  {"name":"candlestick_1m","symbols":["ETHUSD"]},
  {"name":"mark_price","symbols":["MARK:ETHUSD"]},
  {"name":"ticker","symbols":["ETHUSD"]}
]}}
{"type":"unsubscribe","payload":{"channels":[{"name":"ob_updates","symbols":["ETHUSD"]}]}}   // used only to force a fresh book snapshot
```

The server answers a subscribe with `{"type":"subscriptions","channels":[{"name":..,"symbols":[..]}|{"name":..,"error":".."}]}`
(documented, including the error shape). Subscriptions are additive. Delta says "if you subscribe without a symbols list you will not receive any data".

## Heartbeat and liveness

* **Documented**: after `enable_heartbeat` the server sends `{"type":"heartbeat"}` about every 30 s; the recommended client rule is "no heartbeat for 35 s => reconnect".
  There is also `{"type":"ping"}` / `{"type":"pong"}`.
* **What the browser client does** (stricter on purpose, because this feed drives a price the operator watches): *any* inbound message resets the clock;
  silence for 10 s => close and reconnect (back-off + jitter), status becomes "fallback" and the backend quote is shown. Heartbeats are 30 s apart so they alone never keep the link "live";
  ETHUSD data (book/trades/candle) normally arrives several times a second.

## Channels (all documented in the slate source)

Prices and sizes are **strings** in the book channels, numbers/strings mixed elsewhere; the parser accepts both. Timestamps are **microseconds**.
Sizes in the book are **contracts**; ETHUSD is a linear perpetual with `contract_value` 0.01 ETH (REST product field; the hook option `contractValue` defaults to 0.01), so ETH = contracts x 0.01.

| Channel | Fields we read | Cadence |
|---|---|---|
| `ob_l1` | `bp`,`bs` (best bid price, size), `ap`,`as` (best ask), `sy`, `lts`, `ts`; a side with no orders has null price/size | 100 ms, or at most 5 s when unchanged |
| `ob_l2` | `b`,`a` = top **15** levels `[price,size]`, `sy`, `lts`, `ts`. Full replacement every message, no sequence number | 500 ms (10 s when unchanged) |
| `ob_updates` | `action` = `snapshot` / `update` / `error`, `a`,`b` (`[price,size]`, asks ascending, bids descending), `seq`, `cs` (CRC32), `ts`, `sy` | 100 ms; no update message while the book is unchanged |
| `trades` | `p` price, `s` size (contracts), `r` **buyer_role** (`"m"` maker / `"t"` taker), `sy`, `t` trade time, `ts` publish time | per trade |
| `candlestick_1m` | `o`,`h`,`l`,`c`,`v`, `res`:`"1m"`, `sy`, `ts`, `type:"candlestick_1m"`. Subscribing with the plain symbol gives traded-price candles; `MARK:ETHUSD` would give mark-price candles (no `v`), we do not subscribe to those | not documented |
| `mark_price` | `p`, `sy` = `MARK:ETHUSD`, `ts` | 2 s |
| `ticker` | 24 h `ohlc` `[open,high,low,close]`, mark `m`, quotes `q`, `sy`, `ts`; used only for the 24 h change % | 5 s |

### How `ob_updates` is maintained (documented, implemented in `book.ts`)

1. The first message after subscribing is `action:"snapshot"` = the **complete** book at that moment; later messages are `action:"update"` = the difference.
2. Each update row is `[price, new size]`: new size `0` deletes the level, an existing price is replaced, an unknown price is inserted.
3. `seq` must be exactly `last + 1`. On a mismatch Delta says to resubscribe and start from the snapshot. Our policy: `seq` greater than expected = a gap => resync;
   `seq` less than or equal to the last applied one = a duplicate/old frame => ignored (the book is already past it); updates before the first snapshot are ignored.
4. `action:"error"` ("Snapshot load failed ...") => resubscribe after a few seconds (we wait 3 s).
5. **Checksum** (`cs`): after applying an update, build `asks = "p0:s0,p1:s1,..."` (best 10 levels, ascending) and `bids` (best 10, descending), join as `asks|bids`, CRC32 (unsigned 32-bit)
   of that string must equal `cs`. The price/size strings are used exactly as Delta sent them. **The two examples printed in the docs reproduce exactly with our implementation**
   (snapshot `cs` 2178756498, update `cs` 3409694612; they are test vectors in `book.test.ts`). The same check is applied to snapshots (inferred: the docs print a `cs` on the snapshot example and it matches).
6. A checksum mismatch => resync. **Inferred safety valve**: because the live exchange could not be reached, if 3 consecutive snapshots/updates fail the checksum without any success in between,
   checksum verification is switched off for the rest of that page session (sequence checking stays on) instead of looping forever. The browser book is display-only (the trading worker uses its own server-side data).

### Why `ob_l2` is subscribed as well

It is a second, independent, much simpler depth source (top 15 levels, 500 ms, no state). The order-flow card uses it while the `ob_updates` book is being resynchronised or if that channel
is refused, so the card is never blank because of one channel's problem. When the incremental book is in sync it wins.

## Price, change and candles: what is documented and what is inferred

* **Last price** = the latest `trades` price (every trade, in arrival order). If the tape is quiet for 2 s the forming candle's close is used, and after 5 s the book mid-price (inferred; ETHUSD trades constantly).
* **Taker side** (inferred from the documented `r` = buyer_role): `r:"t"` => the buyer was the taker => `buy`; `r:"m"` => the seller was the taker => `sell`.
* **Candle start time is not in the 1m candle message** (only `ts`, described as "timestamp"). Whether `ts` is the publish time or the candle open time is not documented, so the bucket is `floor(ts / 60 s)`, which is right in both cases except for a closing update published a fraction of a second after the minute rolls over;
  a documented-range heuristic (same open, wider-or-equal high/low, within 1.5 s of the boundary) folds such a late update back into the previous candle (`candles.ts`).
* Between candle messages the forming candle is also nudged by every trade price (close/high/low only; volume comes only from the candle message, so units never mix).
* **There is no history channel.** The chart history comes from `seedCandles` (backend snapshot); the feed then takes over.
* `changePct` is the 24 h change from the `ticker` channel's `ohlc[0]` (the exact JSON layout of the ticker sample in the docs is irregular, the parser accepts `ohlc` at the top level or inside `d`); until the ticker arrives it is the change over the loaded candle window (`changeLabel` says which).

## Gap, error and fallback matrix (what the user sees)

| Situation | Behaviour |
|---|---|
| socket opens, first data arrives | status "live" (label "Live"), source `delta-ws` |
| book gap / checksum failure | unsubscribe + subscribe `ob_updates`; depth meanwhile from `ob_l2` |
| no data for 10 s, close, error, handshake refused | reconnect with back-off + jitter; status "fallback" (label "Delayed") showing the backend quote, or "down" ("Reconnecting") if there is none |
| tab hidden | state updates stop (no React work); on return the link is checked at once and the book is resynchronised if the tab was hidden for more than 20 s |
| malformed JSON, unknown type, impossible numbers | message ignored, never throws |

## Content-Security-Policy

The dashboard needs `connect-src 'self' wss://public-socket.india.delta.exchange` (add `wss://socket-ind-pub.testnet.deltaex.org` only if `wsUrl` is pointed at testnet). No other origin is contacted by this layer.

## What was verified, and how (and what was not)

* **Unit tests** (`npx vitest run apps/web/lib/market`): message parser incl. hostile input; the order-book reducer against the **two checksum examples printed in the docs**, the documented insert/delete/replace example, gaps, duplicates, out-of-order frames, checksum failures and the give-up valve, depth exhaustion; candle merging and the forming-candle rules; the status state machine (connecting -> live -> fallback -> down, seed fallback, reconnect replay); the socket lifecycle with a fake WebSocket and fake timers (single socket under React StrictMode, exact back-off 1/2/4/8/16 s, 10 s stale detection, resubscribe on gaps, throttle <= 20 updates/s under a 500 msg/s burst, hidden tab does no React work); server-side render of the three components.
* **Real browser** (headless Chromium via Playwright) against a local fake exchange that speaks this protocol over a real socket (and against the production Next build with the dashboard's CSP enforced, the socket intercepted by Playwright): live prices, depth, chart, drop/reconnect, silence, sequence gap, hidden tab, light/dark, 1360 / 390 / 360 / 320 px wide, reduced motion.
* **Not verified**: anything against the real Delta servers (unreachable here). The assumptions that only the real feed can confirm are listed above as "inferred": browser Origin acceptance, candle `ts` meaning, behaviour of a repeated subscribe, ticker JSON layout, real message rates and book size.
