## Auth & Host Communication Standards

Every dashboard built with this skill runs **inside the Munshot host as an iframe** and talks to the host through the **Munshot Dashboard SDK**. This file is the single source of truth for that integration. If you follow it exactly, the dashboard connects to the host on the first try and receives the user's session token and selected ticker automatically.

These standards are derived from the shipped SDK bundle (`munshot-dashboard-sdk.v1.0.0`) and the host context contract. Do not improvise around them — the handshake is timing-sensitive and small deviations silently break the connection (the dashboard renders but never receives a token).

---

### 0. The Golden Rules (read first)

These are non-negotiable. Most of them exist because violating them produces a **silent** failure (no error, dashboard just never connects).

1. **Load the SDK as a classic `<script>` in `<head>`** — not as an ES module, not `async`/`defer`. It must define `window.MunshotDashboardSDK` before your app boots.
2. **Create the SDK client exactly once, at module load** (`src/lib/sdk.ts`). The constructor attaches the `window` message listener immediately, so it can catch `host:init` even before React mounts.
3. **Leave `autoReady` at its default (`true`). Never set it to `false`.**
4. **Never call `sdk.ready()` yourself.** The SDK sends `dashboard:ready` automatically from inside its `host:init` handler — i.e. at the exact moment it has learned its `channelId`. Calling `ready()` manually from a mount effect races ahead of `host:init`, sends the ready with a placeholder channel the host cannot correlate, and the connection never completes.
5. **Read context with `sdk.getContext()` and re-sync on every `sdk.onMessage(...)`.** Do not `await sdk.requestContext()` — `requestContext()` returns a **boolean**, not the context.
6. **`onRequest` handlers must never throw and must return small, structured-cloneable data** (≤ 512 KB; plain JSON or `Blob`). A thrown error or a non-cloneable/oversized return value causes the response to be dropped and the host to **time out**.
7. **No standalone auth.** No login pages, no hardcoded tokens/tickers, no secrets in the bundle. The host owns identity.

---

### 1. SDK Script

Load the SDK from the Munshot CDN as a **classic blocking script**, before your application bundle:

```html
<!-- index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Munshot Dashboard</title>

    <!-- REQUIRED: classic script, in <head>, before the app module.
         Defines window.MunshotDashboardSDK. Do NOT add type="module",
         async, or defer — load order matters. -->
    <script src="https://munshot.s3.ap-south-1.amazonaws.com/SDK+script/munshot-dashboard-sdk.v1.0.0.min.js"></script>

    <style>
      html, body, #root { margin: 0; padding: 0; height: 100%; }
      body { overflow: hidden; } /* only the dashboard's Zone 2 scrolls */
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

> **Why classic, not module:** the bundle is an IIFE. Loaded as a classic script, `window.MunshotDashboardSDK` resolves to the module namespace that exposes `createDashboardClientSdk`. Loaded as `type="module"`, the same global instead exposes `{ createClient, Client }`. The adapter below probes for all of these, but the classic-script form is the supported, tested setup.

If/when an internal package is published, you may instead `import { createDashboardClientSdk } from "@munshot/dashboard-sdk"` and skip the script tag. Until then, use the script tag.

---

### 2. Required File Structure

The integration is intentionally split into small, fixed-responsibility files. Reproduce these exactly; only the dashboard's own widgets change between projects.

```
src/
  lib/sdk.ts              # SDK client singleton + types + no-op fallback  (copy verbatim, set id/name)
  hooks/useHostContext.ts # session + market context as React state        (copy verbatim)
  main.tsx                # mounts the app
  <your-dashboard>.tsx    # your UI + host request handlers (capture.visual / capture.snapshot)
index.html                # loads the SDK script (section 1)
```

Install the one runtime dependency used by the visual snapshot handler:

```bash
npm install html-to-image
```

---

### 3. `src/lib/sdk.ts` — copy verbatim

Set `DASHBOARD_ID` / `DASHBOARD_NAME` per dashboard. Change nothing else.

```ts
// src/lib/sdk.ts
//
// Munshot Dashboard SDK client adapter. Typed against the shipped bundle
// (munshot-dashboard-sdk.v1.0.0). Creates ONE module-scoped client whose
// window 'message' listener is attached on construction, so the SDK receives
// and caches host:init even before the UI mounts.

export const DASHBOARD_ID = "your-dashboard-id";     // <-- set per dashboard
export const DASHBOARD_NAME = "Your Dashboard Name"; // <-- set per dashboard

export interface SessionContext {
  token: string | null;     // JWT bearer token for Munshot APIs
  userName: string | null;
  email: string | null;
  orgId: string | null;
  orgName: string | null;
}

export interface MarketContext {
  selectedTicker: string | null;        // e.g. "AAPL"
  selectedTickerCompany: string | null; // e.g. "Apple Inc."
  selectedTickerCountry: string | null; // e.g. "US"
  selectedSymbol: string | null;        // TradingView format, e.g. "NASDAQ:AAPL"
}

export interface AppContext {
  route: string | null;
  query: string | null;
  viewMode: string | null;        // "grid" | "list"
  selectedCategory: string | null;
  searchQuery: string | null;
}

export interface DashboardHostContext {
  session?: SessionContext;
  market?: MarketContext;
  app?: AppContext;
}

export interface DashboardSdkEnvelope {
  namespace: string;
  version: string;
  channelId: string;
  source: "host" | "dashboard";
  kind: string;       // "host:init" | "host:context:update" | "host:event" | ...
  timestamp: number;
  requestId?: string;
  payload?: any;
}

export interface NormalizedTopic {
  topic: string;
  data: any;
  metadata?: any;
}

export interface TopicMeta {
  origin: string;
  topic: string;
  requestId?: string;
}

export interface RequestOptions {
  timeoutMs?: number;
  metadata?: unknown;
}

export interface DashboardClientSdk {
  getContext(): DashboardHostContext | null;
  getChannelId(): string | null;
  onMessage(
    handler: (envelope: DashboardSdkEnvelope, meta: { origin: string }) => void,
  ): () => void;
  onTopic(
    topic: string,
    handler: (t: NormalizedTopic, meta: TopicMeta, env: DashboardSdkEnvelope) => void,
  ): () => void;
  onRequest(
    topic: string,
    handler: (
      t: NormalizedTopic,
      meta: TopicMeta,
      env: DashboardSdkEnvelope,
    ) => unknown | Promise<unknown>,
  ): () => void;
  ready(): boolean;
  requestContext(): boolean;
  publish(topic: string, data?: unknown, metadata?: unknown): boolean;
  request(topic: string, data?: unknown, options?: RequestOptions): Promise<any>;
  sendError(message: string, code?: string, details?: unknown): boolean;
  destroy(): void;
}

export interface CreateClientConfig {
  dashboardId: string;
  dashboardName?: string;
  autoReady?: boolean;            // DEFAULT true — leave it
  requestTimeoutMs?: number;      // default 15000
  maxPayloadBytes?: number;       // default 524288 (512 KB)
  lockOriginOnFirstMessage?: boolean; // default true
  allowedOrigins?: string[];
  targetWindow?: Window | null;   // default window.parent ?? window.opener
  targetOrigin?: string;          // default "*"
}

type SdkFactory = (config: CreateClientConfig) => DashboardClientSdk;
type SdkCtor = new (config: CreateClientConfig) => DashboardClientSdk;

declare global {
  interface Window {
    MunshotDashboardSDK?: {
      createDashboardClientSdk?: SdkFactory;
      createClient?: SdkFactory;
      DashboardClientSdk?: SdkCtor;
      Client?: SdkCtor;
    };
  }
}

// Faithful no-op, used ONLY when the SDK script is absent (e.g. running the
// build standalone outside the Munshot host). Return types match the real
// client so app code behaves identically.
function createNoopSdk(): DashboardClientSdk {
  return {
    getContext: () => null,
    getChannelId: () => null,
    onMessage: () => () => {},
    onTopic: () => () => {},
    onRequest: () => () => {},
    ready: () => false,
    requestContext: () => false,
    publish: () => false,
    request: async () => null,
    sendError: () => false,
    destroy: () => {},
  };
}

function initSdk(): DashboardClientSdk {
  const g = window.MunshotDashboardSDK;
  const config: CreateClientConfig = {
    dashboardId: DASHBOARD_ID,
    dashboardName: DASHBOARD_NAME,
    // Leave autoReady default (true). The SDK sends dashboard:ready itself
    // from inside its host:init handler, once it knows the channelId.
  };

  const factory = g?.createDashboardClientSdk ?? g?.createClient;
  if (typeof factory === "function") {
    try {
      return factory(config);
    } catch (err) {
      console.error("[dashboard] SDK factory failed", err);
    }
  }

  const Ctor = g?.DashboardClientSdk ?? g?.Client;
  if (typeof Ctor === "function") {
    try {
      return new Ctor(config);
    } catch (err) {
      console.error("[dashboard] SDK constructor failed", err);
    }
  }

  console.warn(
    "[dashboard] MunshotDashboardSDK not found; using no-op SDK. " +
      "Expected only when running outside the Munshot host iframe.",
  );
  return createNoopSdk();
}

// Single client for the whole app. Created at import time so its message
// listener is live before host:init can arrive.
export const sdk: DashboardClientSdk = initSdk();
```

---

### 4. `src/hooks/useHostContext.ts` — copy verbatim

This is the authoritative way to consume host context. It reads whatever the SDK has cached, then re-syncs on every host message.

```ts
// src/hooks/useHostContext.ts
import { useEffect, useState } from "react";
import { sdk, type SessionContext } from "../lib/sdk";

const EMPTY_SESSION: SessionContext = {
  token: null, userName: null, email: null, orgId: null, orgName: null,
};

export function useHostContext() {
  const [session, setSession] = useState<SessionContext>(EMPTY_SESSION);
  const [ticker, setTicker] = useState<string | null>(null);
  const [tickerCompany, setTickerCompany] = useState<string | null>(null);
  const [tickerCountry, setTickerCountry] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => {
      const ctx = sdk.getContext();
      if (!ctx) return;
      if (ctx.session) setSession({ ...EMPTY_SESSION, ...ctx.session });
      if (ctx.market) {
        setTicker(ctx.market.selectedTicker ?? null);
        setTickerCompany(ctx.market.selectedTickerCompany ?? null);
        setTickerCountry(ctx.market.selectedTickerCountry ?? null);
        setSelectedSymbol(ctx.market.selectedSymbol ?? null);
      }
    };

    sync();                    // apply already-cached context (host:init may
                               // have arrived before this component mounted)
    return sdk.onMessage(sync); // re-sync on every host message; returns unsub
  }, []);

  return { session, ticker, tickerCompany, tickerCountry, selectedSymbol };
}
```

> **Do not** call `sdk.ready()` or `sdk.requestContext()` here, and **do not** add an `await`. Connection (`dashboard:ready`) is handled by the SDK; this hook only reads.

---

### 5. Host Request Handlers + Bootstrap (in your dashboard component)

The host can send **requests** to the dashboard. You must handle two, and your handlers must be bulletproof (rule #6). Register them in a single mount effect. **Do not call `ready()`.**

```tsx
import { useEffect, useRef } from "react";
import { toBlob } from "html-to-image";
import { sdk } from "./lib/sdk";

export function Dashboard() {
  // A getter pointing at the dashboard's current state, reassigned each render
  // so the snapshot handler always reads live values without stale closures.
  const snapshotRef = useRef<() => unknown>(() => ({}));

  // ... your widgets/state ...

  // Keep the snapshot getter current (cap large fields so the payload stays
  // small and structured-cloneable — see rule #6).
  snapshotRef.current = () => ({
    context:   { /* current filters, selected ticker, etc. */ },
    selection: { /* what the user has selected inside the dashboard */ },
    data:      { /* aggregated/derived data, bounded in size */ },
  });

  useEffect(() => {
    // 1) Visual snapshot — return a PNG Blob of Zone 2.
    const offVisual = sdk.onRequest("dashboard.capture.visual", async () => {
      try {
        const el =
          document.querySelector("#dashboard-main") ||
          document.querySelector("[data-dashboard-capture-root='true']") ||
          document.querySelector("main");
        if (!el) throw new Error("capture root not found");
        const blob = await toBlob(el as HTMLElement, { pixelRatio: 2 });
        if (!blob) throw new Error("empty snapshot blob");
        return { visualSnapshot: blob, capturedAt: new Date().toISOString() };
      } catch (err) {
        // Never throw out of the handler; return a structured, cloneable error.
        return { ok: false, error: (err as Error).message };
      }
    });

    // 2) State snapshot — return the current JSON state of the dashboard.
    const offSnapshot = sdk.onRequest("dashboard.capture.snapshot", () => {
      try {
        return snapshotRef.current();
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    // DO NOT call sdk.ready() here. The SDK auto-sends dashboard:ready on
    // host:init. Calling it manually races the handshake and breaks it.

    return () => {
      offVisual();
      offSnapshot();
    };
  }, []);

  // ... render ...
}
```

**`dashboard.capture.snapshot` expected return shape** (host reads the dashboard's current state):

```json
{
  "context":   { "ticker": "AAPL", "filters": [ /* ... */ ] },
  "selection": { /* selected items inside the dashboard */ },
  "data":      { /* aggregated data */ }
}
```

**`dashboard.capture.visual`** returns `{ visualSnapshot: Blob, capturedAt: string }`. A `Blob` is structured-cloneable — return it directly, never Base64.

---

### 6. Context Contracts (exact shapes the host sends)

Context arrives on the message channel as envelopes of kind `host:init` (on load) and `host:context:update` (on login/ticker/route change), with the data at `envelope.payload.context`. The SDK caches it; you read it via `getContext()` (section 4).

**`context.session`** — JWT/identity:

```ts
context.session = {
  token:    string | null,  // JWT — Bearer token for Munshot APIs
  userName: string | null,
  email:    string | null,
  orgId:    string | null,
  orgName:  string | null,
}
```

- On iframe load the host sends `host:init` with the full context including the token.
- On login/session refresh the host pushes `host:context:update` with a new token.
- On logout `token` becomes `null` and an update is pushed immediately.
- The host forwards the token regardless of your dashboard's domain. Your deployed domain must still be **CORS-allowlisted on the Munshot APIs** for requests to succeed.

**`context.market`** — selected ticker:

```ts
context.market = {
  selectedTicker:        string | null,  // "AAPL", "RELIANCE"
  selectedTickerCompany: string | null,  // "Apple Inc."
  selectedTickerCountry: string | null,  // "US", "IN"
  selectedSymbol:        string | null,  // TradingView, "NASDAQ:AAPL"
}
```

**`context.app`** — host navigation state:

```ts
context.app = {
  route:            string | null,  // e.g. "/dashboard"
  query:            string | null,  // e.g. "?category=analytics"
  viewMode:         string | null,  // "grid" | "list"
  selectedCategory: string | null,
  searchQuery:      string | null,
}
```

---

### 7. Using Token + Ticker (and required states)

Wait for both `session.token` and (if your dashboard is ticker-bound) `ticker`. Always include `session.token` in the dependency array so widgets re-fetch when the session refreshes.

```tsx
import { useEffect, useState } from "react";
import { useHostContext } from "../hooks/useHostContext";

function ExampleWidget() {
  const { session, ticker } = useHostContext();
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session.token) return;       // session not ready yet
    if (!ticker) return;              // (only if this widget needs a ticker)
    const ctrl = new AbortController();
    fetch(`https://<munshot-api>/your/endpoint?ticker=${ticker}`, {
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
      },
      signal: ctrl.signal,
    })
      .then((r) => r.json())
      .then(setData)
      .catch((e) => { if (!ctrl.signal.aborted) setError(String(e)); });
    return () => ctrl.abort();
  }, [ticker, session.token]); // re-fetch if EITHER changes

  if (!session.token)
    return (
      <div style={{ padding: 16, textAlign: "center", color: "#9ca3af", fontSize: 13 }}>
        Waiting for session…
      </div>
    ); // non-blocking; token=null is transient on load. Never a full-page error.

  if (!ticker) return <EmptyState message="No stock selected" hint="Pick a stock from the portfolio panel." />;
  if (error)   return <ErrorState message={error} />;
  return <div>{/* render data */}</div>;
}
```

Rules:
- `token === null` → show a small "Waiting for session…" notice **inside the widget**, never a full-page error (it's transient on load).
- `selectedTicker === null` → show an empty state and **do not** call ticker-dependent APIs.
- Never hardcode a ticker. For TradingView widgets use `selectedSymbol` (`"EXCHANGE:TICKER"`).

---

### 8. Dashboard → Host (telemetry, requests, errors)

- **Fire-and-forget events** (analytics/telemetry) — `publish`:

  ```ts
  sdk.publish("dashboard.metric", { widget: "heatmap", action: "tile-click", value: "tech" });
  ```

- **Request/response to the host** (needs an answer) — `request` (this is the only method that returns a Promise; it rejects on timeout, default 15s):

  ```ts
  const res = await sdk.request("portfolio.get-selection", {}, { timeoutMs: 8000 });
  ```

- **Report an error to the host** — `sendError(message, code, details)` (note the three positional args):

  ```ts
  sdk.sendError("Failed to load revenue", "REVENUE_FETCH_FAILED", { ticker });
  ```

Use namespaced topics (`analytics.filter.change`, `portfolio.ticker.select`). Keep payloads small (≤ 512 KB) and structured-cloneable; pass IDs/references for large datasets.

---

### 9. Host → Dashboard Events (optional)

The host publishes `host:event` topics, delivered to `sdk.onTopic(...)`. Currently the host emits one on successful connection (handling it is optional):

```ts
// topic: "host.connected", data: { text, sentAt, route }
const off = sdk.onTopic("host.connected", (t) => {
  console.info("connected:", t.data);
});
```

There are currently no `host:command` messages. Register `onTopic("*", ...)` only for observability/logging.

---

### 10. Message Model (reference)

Versioned envelope (every message):

```ts
{
  namespace: "munshot-dashboard-sdk",
  version:   "1.0.0",
  channelId: string,                 // assigned by the host on host:init
  source:    "host" | "dashboard",
  kind:      string,                 // see below
  timestamp: number,
  requestId?: string,                // correlation id for requests/responses
  payload?:  any,
}
```

Kinds the dashboard receives (host→dashboard): `host:init`, `host:context:update`, `host:event`, `host:command`, `host:request`, `host:response`. Context is always at `payload.context`. After `host:init` sets the `channelId`, the SDK ignores later messages whose `channelId` does not match.

---

### 11. SDK API Reference (verified)

**Constructor config** (`createDashboardClientSdk(config)`):

| Option | Default | Notes |
| --- | --- | --- |
| `dashboardId` | — (required) | throws if empty |
| `dashboardName` | `= dashboardId` | |
| `autoReady` | `true` | **leave true** |
| `requestTimeoutMs` | `15000` | for `request()` |
| `maxPayloadBytes` | `524288` | 512 KB hard cap on every outgoing payload |
| `lockOriginOnFirstMessage` | `true` | locks to the first host origin seen |
| `allowedOrigins` | none | optional explicit allow-list |
| `targetWindow` | `window.parent ?? window.opener` | |
| `targetOrigin` | `"*"` | locked to host origin after first message |

**Client methods:**

| Method | Returns | Notes |
| --- | --- | --- |
| `getContext()` | `HostContext \| null` | **synchronous**; latest cached context. Primary way to read context. |
| `getChannelId()` | `string \| null` | |
| `onMessage(fn)` | `() => void` | `fn(envelope, { origin })`; returns unsubscribe |
| `onTopic(topic, fn)` | `() => void` | `fn({topic,data,metadata}, meta, envelope)`; topics lowercased; `"*"` wildcard |
| `onRequest(topic, fn)` | `() => void` | return value → response; **must not throw / must be cloneable & ≤512 KB**; `"*"` wildcard |
| `ready()` | `boolean` | auto-called by the SDK; **do not call manually** |
| `requestContext()` | `boolean` | fire-and-forget nudge; **not** a Promise; no-ops until the channel exists |
| `publish(topic, data, metadata)` | `boolean` | pub/sub event to host |
| `request(topic, data, opts)` | `Promise<any>` | request/response; rejects on timeout |
| `sendError(message, code, details)` | `boolean` | |
| `destroy()` | `void` | removes the window listener |

---

### 12. The Connection Handshake (what happens, and why the rules)

```
1. Host renders the iframe and (on load) posts `host:init` with the full
   context (incl. token) and a unique channelId.
2. Your SDK client — created at module load — receives host:init, caches the
   context, records the channelId, and (because autoReady is true) AUTO-SENDS
   `dashboard:ready` back to the host using that channelId.
3. Host receives a dashboard:ready it can correlate -> marks the dashboard
   connected, flushes any queued messages, and may emit `host.connected`.
4. Your useHostContext onMessage fires -> getContext() returns session/market
   -> widgets render and fetch with the Bearer token.
5. Logins / ticker / route changes arrive later as `host:context:update` and
   re-sync the same way.
```

If you call `ready()` yourself from a mount effect, step 2 happens **too early** (before `host:init`, so before the `channelId` exists). The ready goes out with a placeholder channel the host can't match, and — if you also disabled `autoReady` — the SDK never re-sends a correct one. The host waits forever, queued requests (e.g. `dashboard.capture.snapshot`) time out, and the dashboard appears "stuck on Waiting for session…". **This is the single most common failure. Don't do it.**

---

### 13. DO NOT (every trap, with its symptom)

| Don't | Symptom |
| --- | --- |
| Set `autoReady: false` | Handshake never completes; stuck on "Waiting for session…" |
| Call `sdk.ready()` manually | Ready races `host:init`, sent with placeholder channel → never connects |
| `await` / `.then` / `.catch` on `requestContext()` | `TypeError: ... is not a function` (it returns a boolean) → blank page |
| Throw inside an `onRequest` handler | Host gets an error response or (if non-serializable) a timeout |
| Return non-cloneable (functions, DOM nodes) or >512 KB from a handler | Response silently dropped → host times out |
| Create more than one SDK client | Duplicate channels, lost messages |
| Load the SDK with `type="module"` / `defer` | `createDashboardClientSdk` missing on the global; falls back to no-op silently |
| Read context by parsing envelopes by hand instead of `getContext()` | Fragile; breaks on shape changes |
| Hardcode tokens/tickers, build a login page, store secrets | Violates the host auth model; rejected in review |

---

### 14. Pre-Submission Checklist

- [ ] SDK loaded as a **classic** `<script>` in `<head>` (no `module`/`async`/`defer`).
- [ ] **One** SDK client created at module load in `src/lib/sdk.ts`.
- [ ] `autoReady` left at default; **no manual `sdk.ready()`** anywhere.
- [ ] Context consumed via `useHostContext` (`getContext()` + `onMessage` re-sync).
- [ ] All API calls use `Authorization: Bearer ${session.token}`.
- [ ] `token === null` → in-widget "Waiting for session…", never a full-page error.
- [ ] `selectedTicker === null` → empty state; no ticker-dependent calls.
- [ ] `dashboard.capture.visual` returns a `Blob` of `#dashboard-main`.
- [ ] `dashboard.capture.snapshot` returns bounded, cloneable `{ context, selection, data }`.
- [ ] Every `onRequest` handler is wrapped so it never throws and never returns >512 KB / non-cloneable data.
- [ ] No hardcoded tokens/tickers, no standalone login, no secrets in the bundle.
- [ ] Deployed dashboard domain is CORS-allowlisted on the Munshot APIs (host-side, coordinate with the platform team).
