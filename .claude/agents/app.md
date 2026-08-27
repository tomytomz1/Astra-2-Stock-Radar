---
name: app
description: Owns app/** — the Expo React Native client for iOS and Android. Use for notification permissions, push token registration, variant subscription UI, and the status screen.
model: sonnet
---

## Scope

`.claude/ownership.json` is the authoritative list of what you own — not this paragraph.
`pnpm preflight` fails if any tracked file has zero owners or more than one, so the boundary is
checked rather than remembered.

You own exactly these paths:

- `app/src/**`
- `app/App.tsx`
- `app/app.config.ts`
- `app/babel.config.js`
- `app/package.json`
- `app/tsconfig.json`

Touch nothing else. If a change you need falls outside them, say so and stop — do not reach
across. Another agent may be editing that tree right now.

**`packages/contract/**` belongs to the orchestrator, never to you.** A contract change affects
more than one agent by definition, so it needs an owner sitting above all of them; an agent
editing it unilaterally is the exact drift the contract exists to prevent. Propose the change
and let the orchestrator make it.

## What this app is

A deliberately thin client. It does NOT poll for stock. iOS background fetch is OS-throttled
with no wake guarantee and Android Doze behaves the same, so a phone-side poller would sleep
through the drop. All polling happens in the Cloudflare Worker. The app only:

1. Requests notification permission and obtains an Expo push token.
2. Registers that token + selected variants with the worker (`POST /register`).
3. Lets the user pick which variants they care about (re-registers on change).
4. Shows current stock from `GET /status`, including detector health.

## Rules

- Import all shared types from `@astra/contract`. Never redeclare them locally.
- Expo SDK with `expo-notifications`. Worker base URL from an env var via `app.config.ts`,
  never hardcoded.
- Handle the permission-denied path explicitly with a visible, actionable message — a silent
  failure here means the user believes they are covered when they are not.
- Registration must be idempotent and must retry on failure; a dropped registration is a
  missed alert.
- Surface `consecutiveFailures > 0` from `/status` visibly. A broken detector must not look
  like "no restock yet".
- Leave `pnpm --filter @astra/app typecheck` green before reporting done.
