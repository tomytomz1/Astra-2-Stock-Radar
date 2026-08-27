# Astra 2 Stock Radar

Push alerts the moment the [REDMAGIC Astra 2 Gaming Tablet](https://global.redmagic.gg/products/redmagic-astra-2-gaming-tablet)
becomes purchasable, sent to a phone within ~60 seconds of the drop.

## What it is

A Cloudflare Worker polls the product page every minute and fires an Expo push the instant any
variant flips from sold out to available. A thin Expo app (iOS + Android) does nothing but
register a push token and show the last known status — it never checks stock itself.

**The phone never polls. This is the whole design.** iOS background fetch is OS-throttled with
no wake guarantee, and Android Doze behaves the same way — a phone-side poller would sleep
through a drop that can be over in under a minute. So *all* polling lives server-side, in the
Worker, on a 1-minute cron (`worker/wrangler.toml`). The app's only jobs are: request
notification permission, register the resulting Expo push token + chosen variants with the
Worker (`POST /register`), and display `GET /status`. If you're tempted to add a `setInterval`
or background-fetch task to the app — don't; it will not fire reliably, and it's not how alerts
are supposed to work here.

```
┌─────────────┐   1-min cron    ┌──────────────────┐   POST (on restock)   ┌─────────────┐
│   Product    │◄───────────────│  Cloudflare       │──────────────────────►│  Expo Push  │
│   page       │  detect adapter│  Worker           │                        │  Service    │
└─────────────┘  chain          │  worker/src/**    │                        └──────┬──────┘
                                 │  KV: latch state  │                               │
                                 └────────▲──────────┘                               ▼
                                          │ POST /register                    ┌─────────────┐
                                          │ GET  /status                      │  iOS /      │
                                          │                                   │  Android app│
                                          └───────────────────────────────────┤  (no poll)  │
                                                                               └─────────────┘
```

Detection is a chain of four strategies, tried in order, first success wins (see
`packages/contract/src/index.ts` → `ADAPTER_ORDER`): `shopify-js` (`{url}.js`), `shopify-json`
(`{url}.json`), `jsonld` (`<script type="application/ld+json">`), `heuristic` (regex over the
raw page). Which one actually works against the live store is unknown until you run the probe
(see checklist step 5) — that's deliberate, since this environment cannot reach the store to
find out for you.

## Why it will not cry wolf

Two safeguards make the difference between an alert worth trusting and one you learn to ignore:

- **A failed fetch is never recorded as "out of stock."** If the Worker can't reach the store,
  or the page structure breaks a detector, that pass leaves all KV state untouched. Otherwise a
  timeout would look identical to a real sellout, and the store's next successful fetch would
  read as a false→true "restock" that never happened.
- **Each variant has a 6-hour cooldown after alerting** (`ALERT_COOLDOWN_MS`), so a flapping
  storefront can't spam you.

The alert fires on the **first** observed in-stock reading — there is no second confirming pass.
That's deliberate, not an oversight: a confirmation pass would add another ~60s cron tick to a
buying window that can already be shorter than that.

## Setup checklist

Run these in order. Assumes an approved Apple Developer account and nothing else configured.

| # | Step | Command | Time |
|---|------|---------|------|
| 1 | Install dependencies | `pnpm install` | ~1 min |
| 2 | Authenticate wrangler | `npx wrangler login` (opens a browser) | ~1 min |
| 3 | Create the KV namespace, then paste the id in | `npx wrangler kv namespace create STOCK_KV` | ~1 min |
| 4 | Add secrets (see below) | none strictly required | — |
| 5 | Fingerprint the live store | `pnpm probe` | ~1 min |
| 6 | Deploy the Worker | `pnpm deploy:worker` | ~1 min |
| 7 | Point the app at the Worker | edit `app/eas.json` | ~1 min |
| 8 | Build the app | `npx eas login` then `eas build --profile preview --platform all` | 10–20 min (remote build queue — you wait on EAS) |
| 9 | Ship to devices | `eas submit -p ios`; sideload the Android APK | ~5 min iOS submit + TestFlight processing (10–30 min); APK install is immediate |
| 10 | Grant permission, pick variants | in-app | ~1 min |
| 11 | Prove the pipeline end to end | `pnpm simulate-restock <variantId>` | ~1–2 min (waits for the next cron tick) |

### Step 3 detail — KV namespace

```
npx wrangler kv namespace create STOCK_KV
```

This prints an `id` (and, if you pass `--preview`, a separate `preview_id`). Paste them into
`worker/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "STOCK_KV"
id = "REPLACE_WITH_KV_NAMESPACE_ID"          # <- paste the returned id here
preview_id = "REPLACE_WITH_PREVIEW_KV_NAMESPACE_ID"  # <- paste here if you created a preview namespace
```

Wrangler refuses to deploy while either field is still a `REPLACE_WITH_...` placeholder, so a
forgotten paste fails loudly at deploy time, not silently at runtime.

### Step 4 detail — secrets

Nothing in the current worker **requires** a secret — `/register` takes no auth token, and a
basic Expo push send needs no credential. One secret is wired up but optional:

```
# From worker/, or: pnpm --filter @astra/worker exec wrangler secret put EXPO_ACCESS_TOKEN
wrangler secret put EXPO_ACCESS_TOKEN
```

Set this only if you've enabled Expo's "Enhanced Security" for push sends on your Expo project
— recommended once the Worker URL is public, so strangers can't send pushes through your
tokens. If unset, the Worker sends unauthenticated Expo push requests (Expo's default). There is
no `ADMIN_TOKEN` or similar gating `/register` — anyone with the Worker URL can register a
token today; that's an accepted gap, not a missing step.

### Step 5 detail — the probe

```
pnpm probe
```

This is the **only** step that touches the live store. It fetches `PRODUCT_URL`, runs all four
detection adapters, prints a per-adapter OK/FAILED report with parsed variants, and writes
`worker/src/detect/config.json` (the `DetectConfig` the Worker reads at runtime — no code change
needed). Read the printed report:

- If one adapter succeeded, it's now `preferredAdapter` in the config — you're done, go to step 6.
- If only `heuristic` could work (or none did), open `worker/src/detect/config.json` and hand-tune
  `soldOutPatterns` / `inStockPatterns` using the "candidate stock-related phrases" the probe
  prints, then re-run `pnpm probe` until an adapter reports OK. Do not deploy with every adapter
  failing — the cron pass will never detect a restock.
- `pnpm probe <url>` overrides the target (e.g. to test against a different store).

### Step 6 detail — deploy and find the Worker URL

```
pnpm deploy:worker
```

Wrangler prints the deployed URL on success, in the form:

```
https://astra-2-stock-radar.<your-subdomain>.workers.dev
```

(the worker name `astra-2-stock-radar` comes from `worker/wrangler.toml`'s `name` field). Copy
that URL — you need it in step 7.

### Step 7 detail — point the app at the Worker

`app/app.config.ts` reads the Worker URL from the `EXPO_PUBLIC_WORKER_URL` env var at build
time. The `preview` build profile in `app/eas.json` already has a placeholder for it — replace
it directly:

```json
"preview": {
  "distribution": "internal",
  "android": { "buildType": "apk" },
  "ios": { "distribution": "store" },
  "env": {
    "EXPO_PUBLIC_WORKER_URL": "https://astra-2-stock-radar.<your-subdomain>.workers.dev"
  }
}
```

This is a public URL, not a secret — committing it is fine.

### Step 8 detail — build

```
npx eas login
eas build --profile preview --platform all
```

`preview` is the real profile name in `app/eas.json` (not `production`). It produces an
installable Android **APK** (`android.buildType: "apk"`) and an iOS build set for **store**
distribution (`ios.distribution: "store"`), i.e. suitable for TestFlight. This step queues a
remote build on EAS's infrastructure — expect 10–20 minutes per platform, and you can close the
terminal; `eas build` gives you a link to watch progress.

### Step 9 detail — ship to devices

```
eas submit -p ios
```

Uses the `submit.preview` profile in `app/eas.json`. After Apple finishes processing (typically
10–30 min), install via TestFlight on the iOS device. For Android, download the APK EAS built in
step 8 and sideload it directly (enable "install unknown apps" for your file manager/browser).

### Steps 10–11 — verify

1. Open the app, grant the notification permission when prompted, and select the variant(s) you
   care about (or leave the selection empty to mean "all variants").
2. Run the real end-to-end test:

```
pnpm simulate-restock                # no args: lists current variant states from KV
pnpm simulate-restock <variantId>    # resets that variant's alert latch
pnpm simulate-restock <variantId> --dry-run   # shows what would be written, writes nothing
```

This does **not** fake availability — it only resets one variant's alert latch in KV to
`{available: false, lastAlertedAt: null}`. The Worker's next real cron tick (within ~60s) still
fetches the real store; a push only fires if that variant is genuinely purchasable right now. So
pick a variant that's actually in stock (any variant will do — it doesn't have to be the specific
configuration you're waiting for; run `pnpm probe` first if you're unsure which one that is).
The script prints the exact `wrangler kv key put`/`delete` command to undo itself. Watch your
device for the notification, or poll `GET /status` on the deployed Worker.

## Troubleshooting

| Symptom | Check, in order |
|---|---|
| No notification ever arrives | 1. Did the app register? (check `POST /register` succeeded, no error toast) 2. Is the Worker actually deployed? (`pnpm deploy:worker` again, or check the Cloudflare dashboard) 3. Is the cron firing? (Cloudflare dashboard → Worker → Triggers → recent cron invocations) 4. `curl https://<worker-url>/status` — does `lastSuccessAt` update roughly every minute? |
| `GET /status` shows `consecutiveFailures > 0` | The detector is broken, most likely because the store changed its markup. Re-run `pnpm probe` to see which adapter(s) now fail and why. If you can't fix the adapter/pattern yourself, `.claude/agents/watcher.md` defines an agent scoped to `worker/**` (detection adapters, KV state, dispatch) — ask it to fix the detector. |
| Probe hits a Cloudflare/bot-challenge page | `pnpm probe` prints a specific warning when the response body looks like a challenge page (`cf-chl`, "checking your browser", captcha, etc). A plain server fetch can't pass a JS challenge — open the URL in a real browser and check whether it's only shown to new/unusual IPs. If every visitor gets it, none of the four adapters (nor the Worker built on them) can watch this store as-is. |
| TestFlight build expired | TestFlight internal builds expire ~90 days after upload. Re-run `eas build --profile preview --platform ios` then `eas submit -p ios`. |
| Push never lands / Expo reports `DeviceNotRegistered` | The Worker already prunes dead tokens from its registry on `DeviceNotRegistered` receipts — if yours got pruned, just re-open the app so it re-registers a fresh token (uninstall/reinstall or a token refresh both trigger this). |
| Testing on a simulator/emulator and nothing arrives | Expected — push tokens do not work on iOS Simulator or most Android emulator images. Use a real device for steps 10–11. |

## Development

```
pnpm typecheck                                   # all workspace packages + scripts/
pnpm test                                         # worker unit tests (vitest, mocked fetch, no network)
pnpm --filter @astra/worker exec wrangler dev --test-scheduled
```

The last command runs the Worker locally and lets you trigger the cron path without waiting for
a real minute to tick: with `wrangler dev` running, hit `http://localhost:8787/__scheduled` (add
`?cron=*+*+*+*+*` if wrangler asks you to disambiguate) to fire one `scheduled()` pass against
your local dev environment.

CI (`.github/workflows/ci.yml`) runs typecheck and tests only on every push/PR — no deploy step,
no credentials. All real deploys (`pnpm deploy:worker`, `eas build`/`eas submit`) run from a
developer machine, following this checklist.

## Deliberately not built

Auto-add-to-cart: it would close the gap between alert and sellout, but it's very likely against
the store's Terms of Service, so it was flagged rather than built.
