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
raw page). `worker/src/detect/index.ts` runs the whole chain on every pass and uses the first
adapter that succeeds, and the shipped `worker/src/detect/config.json` ships with no preferred
adapter set — so a freshly deployed Worker already self-resolves detection with zero
configuration. `pnpm probe` (optional — see Troubleshooting) pins down which adapter actually
wins against the live store, which only saves the Worker up to three wasted fetches per minute;
it is not required to get a working deploy.

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

**Steps 2 and 3 run in parallel, not in sequence.** The app build is a 10–20 minute remote EAS
queue; the Cloudflare half is about 2–5 minutes end to end. Kick off step 2, then — without
waiting for it to finish — do step 3 in the same terminal (or another one) while it builds.
Doing them back to back costs the sum of both waits; doing them in parallel costs only the
longer one.

| # | Step | Command | Time |
|---|------|---------|------|
| 1 | Install dependencies | `pnpm install` | ~1 min |
| 2 | Start the app build — do this first, then move straight to step 3 while it queues | `npx eas login` then `eas build --profile preview --platform all` | 10–20 min (remote build queue — runs in the background, does not block your terminal) |
| 3 | Provision Cloudflare and deploy the Worker — do this while step 2 builds | `pnpm bootstrap` | ~2–5 min |
| 4 | Add secrets (optional, see below) | none strictly required | — |
| 5 | Ship to devices | `eas submit -p ios`; sideload the Android APK | ~5 min iOS submit + TestFlight processing (10–30 min); APK install is immediate |
| 6 | Grant permission, pick variants | in-app | ~1 min |
| 7 | Prove the pipeline end to end | `pnpm simulate-restock <variantId>` | ~1–2 min (waits for the next cron tick) |

### Step 2 detail — build

```
npx eas login
eas build --profile preview --platform all
```

`preview` is the real profile name in `app/eas.json` (not `production`). It produces an
installable Android **APK** (`android.buildType: "apk"`) and an iOS build set for **store**
distribution (`ios.distribution: "store"`), i.e. suitable for TestFlight. This step queues a
remote build on EAS's infrastructure — expect 10–20 minutes per platform. `eas build` gives you
a link to watch progress; you don't need to wait on it before starting step 3.

### Step 3 detail — `pnpm bootstrap`

```
pnpm bootstrap             # do it for real
pnpm bootstrap --dry-run   # print the plan, create/deploy/write nothing
```

*(Named `bootstrap` rather than `setup` on purpose: `pnpm setup` is pnpm's own built-in command
that writes `PNPM_HOME` into your shell profile, so a script called `setup` would sit behind a
name that silently does something else to your machine.)*

This is `scripts/bootstrap.ts`, and it collapses what used to be five separate commands plus two
manual copy-paste-into-file edits into one. In order, it:

1. Checks you're logged in to wrangler (`wrangler whoami`). If not, it prints the exact
   `npx wrangler login` command and stops — it never attempts to log you in itself.
2. Lists your existing KV namespaces and reuses one already titled for this project, or creates
   a production + preview namespace if neither exists yet.
3. Patches the `id` / `preview_id` placeholders in `worker/wrangler.toml` with the real ids —
   surgically, leaving every comment in the file untouched. If a real id is already configured,
   it reports that and leaves it alone rather than overwriting it.
4. Deploys the Worker (`wrangler deploy`) and parses the printed `*.workers.dev` URL from the
   output.
5. Writes that URL into `app/eas.json`'s `build.preview.env.EXPO_PUBLIC_WORKER_URL` — the exact
   manual paste that used to be the easiest step to get wrong, and the one most likely to fail
   silently (a stale or mistyped URL means the app registers nowhere, and you only find out
   during a drop).
6. Prints a summary: which files changed, the deployed Worker URL, and the next command to run.

If wrangler ever prints a namespace-create or deploy response the script can't parse, it says so
explicitly and tells you where to find the value yourself (the Cloudflare dashboard, or
`wrangler kv namespace list`) rather than writing something guessed.

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

### Step 5 detail — ship to devices

```
eas submit -p ios
```

Uses the `submit.preview` profile in `app/eas.json`. After Apple finishes processing (typically
10–30 min), install via TestFlight on the iOS device. For Android, download the APK EAS built in
step 2 and sideload it directly (enable "install unknown apps" for your file manager/browser).

### Steps 6–7 — verify

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
configuration you're waiting for; `pnpm probe` can show you live variant availability if you're
unsure which one that is — see Troubleshooting). The script prints the exact
`wrangler kv key put`/`delete` command to undo itself. Watch your device for the notification, or
poll `GET /status` on the deployed Worker.

## Known limitation: the registration gap

Between step 3 (the Worker goes live) and step 6 (the app is installed and has registered a push
token), the token registry is empty. If the real product restocks in that window, the Worker
still detects it and still tries to notify — it just has no devices to send to. No error, no
retry, nothing recorded to say a push was owed and never sent.

Starting the build first (step 2) shrinks this window, since most of the wait now happens before
the Worker exists at all rather than after it's already watching. It does not eliminate the gap:
the Worker has to be live for `pnpm bootstrap` to finish, and the app can't register a token
before it's installed. This is deliberately not covered by a second delivery channel (e.g. an
email fallback while devices are still registering) — see "Deliberately not built" below.

## Troubleshooting

| Symptom | Check, in order |
|---|---|
| No notification ever arrives | 1. Did the app register? (check `POST /register` succeeded, no error toast) 2. Is the Worker actually deployed? (`pnpm bootstrap` again, or check the Cloudflare dashboard) 3. Is the cron firing? (Cloudflare dashboard → Worker → Triggers → recent cron invocations) 4. `curl https://<worker-url>/status` — does `lastSuccessAt` update roughly every minute? 5. Did the restock happen in the registration gap between deploy and install? (see "Known limitation" above) |
| `GET /status` shows `consecutiveFailures > 0` | The detector is broken, most likely because the store changed its markup. Run `pnpm probe` to see which adapter(s) fail and why — see the next row. If you can't fix the adapter/pattern yourself, `.claude/agents/watcher.md` defines an agent scoped to `worker/**` (detection adapters, KV state, dispatch) — ask it to fix the detector. |
| Want to speed up detection, or diagnose why every adapter is failing | Run `pnpm probe`. It is **not** a required setup step — the Worker already tries the full adapter chain on every pass and uses the first one that succeeds, so a default deploy self-resolves detection with no configuration. What `pnpm probe` gets you: it fetches `PRODUCT_URL`, runs all four detection adapters, prints a per-adapter OK/FAILED report with parsed variants, and writes `worker/src/detect/config.json` pinning the winning adapter as `preferredAdapter` — saving the Worker up to three wasted fetches per cron pass, and giving you live variant ids for `pnpm simulate-restock`. If it reports every adapter failing, open `worker/src/detect/config.json` and hand-tune `soldOutPatterns` / `inStockPatterns` using the "candidate stock-related phrases" the probe prints, then re-run it until one adapter reports OK — a Worker deployed with every adapter broken will never detect a restock. `pnpm probe <url>` overrides the target (e.g. to test against a different store). |
| Probe hits a Cloudflare/bot-challenge page | `pnpm probe` prints a specific warning when the response body looks like a challenge page (`cf-chl`, "checking your browser", captcha, etc). A plain server fetch can't pass a JS challenge — open the URL in a real browser and check whether it's only shown to new/unusual IPs. If every visitor gets it, none of the four adapters (nor the Worker built on them) can watch this store as-is. |
| TestFlight build expired | TestFlight internal builds expire ~90 days after upload. Re-run `eas build --profile preview --platform ios` then `eas submit -p ios`. |
| Push never lands / Expo reports `DeviceNotRegistered` | The Worker already prunes dead tokens from its registry on `DeviceNotRegistered` receipts — if yours got pruned, just re-open the app so it re-registers a fresh token (uninstall/reinstall or a token refresh both trigger this). |
| Testing on a simulator/emulator and nothing arrives | Expected — push tokens do not work on iOS Simulator or most Android emulator images. Use a real device for steps 6–7. |
| `pnpm bootstrap` fails at the wrangler-auth check | You're not logged in (or the network can't reach Cloudflare) — the printed message tells you which command to run (`npx wrangler login`) and to re-run `pnpm bootstrap` after. It never attempts to log you in itself. |

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
no credentials. All real deploys (`pnpm bootstrap`, `eas build`/`eas submit`) run from a
developer machine, following this checklist.

## Deliberately not built

Auto-add-to-cart: it would close the gap between alert and sellout, but it's very likely against
the store's Terms of Service, so it was flagged rather than built.

A second delivery channel (e.g. email) to cover the registration gap between deploying the
Worker and installing the app (see "Known limitation" above): it would only ever matter for a
restock that lands in a several-minute window on first-ever setup, and adding a second channel
means a second set of credentials and a second thing that can silently break. Re-running
`pnpm simulate-restock` after setup is the mitigation, not a standing second channel.
