# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`gh-triage-agent` — a config-driven, multi-repo, human-in-the-loop GitHub issue/PR triage agent, packaged as a **desktop app** (Electron menu-bar app for macOS/Linux) with an optional headless mode. The core engine polls repos, has Claude judge items opened by others (via the **Claude Agent SDK**, billed to the user's Claude subscription through their Claude Code login), and surfaces each decision as a card in a local web UI. **Every GitHub write happens only after human confirmation** in that UI — the bot never acts on its own. Keep that invariant when changing anything.

Telegram support was removed in 0.2.0; the local Inbox page + native notifications replaced it. Mobile clients (planned) will connect remotely to this core rather than embed it — the Agent SDK cannot run on iOS/Android.

## Layout

```
packages/core/   engine: poller, judge, store, actions, local web UI (all TS, no build step)
apps/desktop/    Electron shell: tray, notifications, window; forks core as a utilityProcess
```

## Commands

```bash
npm run app        # launch the desktop app (Electron)
npm run headless   # daemon without the shell; prints a tokened browser URL
npm run poll-once  # single poll+judge cycle then exit (needs settings already in the DB)
npm run typecheck  # tsc — the only check; there are no tests and no linter
npm run pack       # unpacked .app into dist/ (electron-builder --dir)
npm run dist       # dmg/zip installers (config in root package.json "build")
```

Packaging: electron-builder runs from the repo root (root `package.json` has `main`, the runtime `dependencies` duplicated from packages/core so builder collects them, and the `build` config). **asar is disabled on purpose** — the Agent SDK CLI must be a real file for the judge's spawned subprocess; don't re-enable it without `asarUnpack`-ing the SDK and verifying a judge run.

Node ≥ 22 required. **All user configuration lives in the sqlite `settings` table**, edited on the in-app `/settings` page — there are no config files and no required env vars (`config.yaml`/`.env` were removed in 0.2.0; the zod schema is `SettingsSchema` in `config.ts`). Claude auth: empty token = the machine's Claude Code login; `sk-ant-oat…` = Claude Code OAuth token (subscription tokens share the `sk-ant-` prefix with API keys — match OAuth first); other `sk-ant-…` = API key; anything else = OAuth token (applied by `applyClaudeAuth` in `engine.ts`). Dev-only env overrides: `DB_PATH` (default `./data/state.db`; the desktop shell points it at the per-user app data dir), `REPOS_DIR`.

TypeScript notes: ESM with **`.ts` extensions in imports**, strict, `noEmit` — the code runs directly on Node's type stripping (both `node` CLI and Electron's bundled Node). That means **erasable syntax only** (`erasableSyntaxOnly` is set): no constructor parameter properties, no enums, no namespaces — plain field declarations instead. There is no build step anywhere.

## Architecture

One item's life:

```
poller (Octokit) → judge (Claude Agent SDK) → store.createPending (sqlite)
  → engine emits "card" → desktop notification + Inbox page (local HTTP)
    → human confirms in UI → engine action methods write via Octokit → receipt
```

- `packages/core/src/engine.ts` — `TriageEngine`: the poll→judge→store cycle and the **only** GitHub-write paths (`approveReply` / `executeAction` / `ignore` / `noteReviewSubmitted`). Emits typed events (`card`, `finalized`, `cycle`, `pollError` — deliberately not `error`, which would throw when unlistened).
- `packages/core/src/server.ts` — the app UI, served on **127.0.0.1 only** and gated by a per-install **UI session token** (`store.getOrCreateUiToken()`; the window URL carries `?auth=…` once, then a cookie) so other local processes can't read or drive it — note `/settings` renders the stored tokens. `startHttpServer` resolves with the ACTUAL bound port — always 0 (OS-assigned, conflict-free; the shell learns it from the `ready` message); the port is not user-configurable. Mail-client layout: a fixed sidebar (待处理/已处理 folders grouped per repo via `store.countByRepo()`, 设置/日志 pinned at the bottom, rendered by `renderSidebar`) next to the content column. Routes: `/setup` (first-run two-step wizard: model → GitHub tokens, **no repos** — repos are managed on the settings page; redirects to `/settings` once configured), `/inbox?view=open|done&repo=owner/repo` (folder views; open = cards + actions, done = archived cards — repo management lives in `/settings` only), `/logs` (recent runtime log lines from `log.ts`'s in-memory ring buffer — `initLogCapture()` wraps console.log/warn/error at boot in both entrypoints, memory-only, 1000 lines), `/settings` (GET form / POST JSON, hot-applies via `onSettingsChanged` hook), `/reply/<id>`, `/review/<id>?t=<token>` (PR per-point review; checked points become inline comments, unanchorable ones fall into the review body so GitHub never 422s). `repos` may be empty in `SettingsSchema` (a cycle over zero repos is a no-op) — the wizard saves tokens only. Card mutations additionally carry the per-card `token` as a hidden form field. The server and engine live in the same process — a form POST is a direct method call on the engine, not a relay.
- `packages/core/src/github/poller.ts` — fetches issues/PRs updated after a per-repo cursor; filters bots/maintainers/self; assembles `TriageItem` (PRs: inline patches within a 1MB budget + full file list + head sha).
- `packages/core/src/judge/` — Agent SDK judging. `checkout.ts` shallow-fetches the PR head into `data/repos/` so the model gets read-only `Read`/`Grep`/`Glob` on real code; falls back to the API tools in `tools.ts`. The judged agent is **never given Bash/Edit/Write** — it must not execute untrusted PR code.
- `packages/core/src/store.ts` — single `node:sqlite` DB: `cursors`, `processed` fingerprints, `pending` cards. Migrations are `ensureColumn` calls; `chat_id` is a legacy Telegram-era NOT NULL column (new rows write `""`). `message_id` and `reminded_at` are legacy unused columns (Telegram-era delivery marker; removed reminder feature).
- `packages/core/src/desktop-entry.ts` — core entry inside the Electron `utilityProcess`; message protocol to the shell (`ready`/`card`/`badge` up, `pollNow`/`shutdown` down). Sets `ELECTRON_RUN_AS_NODE=1` so the Agent SDK's spawned CLI (which uses `process.execPath` — the Electron helper) runs as plain Node.
- `apps/desktop/main.js` — Electron shell: tray (badge count), native notifications, single window loading `http://127.0.0.1:<port>/inbox`, single-instance lock, core auto-restart on crash.

### Delivery/retry semantics (easy to break)

The engine marks an item's fingerprint (`itemKey@updatedAt`) processed **only after the card is stored and emitted**, and holds the repo cursor back to the earliest failure so failed items are re-fetched next cycle. The poller skips items whose latest activity is the bot's own account (`lastActorIsSelf`) to avoid self-reply loops — but a newer commit on a PR always counts as new activity. A fresh card supersedes older open cards for the same item.

### Decision schema (dual-maintained)

`judge/schema.ts` has two parallel definitions: zod `DecisionSchema` (validation incl. cross-field rules) and `DecisionJsonSchema` (JSON Schema for the SDK's `outputFormat`). Change both together. Validation failure feeds the zod error back to the model and retries once.

### Language configuration

Three settings drive all language behavior (0.6.0; previously hardcoded English-posted/Chinese-displayed):
- `ui_language` (`zh`|`en`) — interface language; server.ts renders strings through `t()`, whose `EN` map is keyed by the Chinese source string (unlisted strings fall back to Chinese). `applyUiPrefs(store)` sets module-level `UI`/`LANGS` at the top of every request.
- `post_language` (free-form name, default `English`) — what actually gets POSTED to GitHub: `draftReply`, review point `comment`.
- `display_language` (free-form name, default `中文`) — human-facing judge output: `reasoning`, `draftReplyZh`, `commentZh`. The `*Zh` field names are **legacy** — they hold whatever the display language is.

`buildSystemPrompt(postLang, displayLang)` in `judge/prompt.ts` threads both into the judge. Keep the posted-vs-display split for any new user-facing field, and add new UI strings to the `EN` map.

Changing either content language **re-judges all open cards automatically**: `engine.setConfig` detects the change and calls `requeueOpenCards()` (clears the items' `processed` fingerprints via `store.clearProcessedForItem`, rewinds repo cursors to 24h before the earliest open card via `store.rewindCursor`); the next cycle re-fetches and re-judges them, and the fresh cards supersede the old ones through the existing supersede path. Done/archived cards keep their original languages.

### Performance conventions

- `store.ts` `COLS_NO_CTX`: list/sweep queries select `NULL AS context_json` to avoid loading large PR diffs; only `getPending(id)` reads the full row.
- `server.ts` gzips responses; the review page parses each patch once (`parsedByPath`) and lazy-renders collapsed diffs via inert `<template>`s.
