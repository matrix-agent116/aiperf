# gh-triage-agent

A config-driven, multi-repo, **human-in-the-loop** GitHub issue/PR triage agent, packaged as a **desktop app** (macOS/Linux menu-bar app, with a headless mode for servers).

It watches the repos listed in `config.yaml`, uses Claude to judge issues/PRs opened by **others** — "does this need a reply?" and "what's the next action?" — then surfaces each decision as a card in the app's Inbox (with a native notification). Every write to GitHub (posting a comment, closing an issue, approving/rejecting a PR, adding labels) **happens only after you confirm it in the UI** — the bot never acts on its own.

## Why not just another GitHub Action

Existing open-source options (`anthropics/claude-code-action`, Issue AI Agent, `Elifterminal/pr-triage`) are almost all GitHub Actions: bound to a single repo, event-triggered, with the AI commenting directly. This project is the opposite: one long-running local engine that centrally polls many repos, and routes every decision through a human before writing back to GitHub.

## Architecture

```
apps/desktop  (Electron shell: tray badge, notifications, window)
   └─ forks packages/core as a utilityProcess
        ├─ Poll loop (every N minutes)
        │    Octokit fetches issues/PRs opened by others, updated after the cursor
        │      → Claude Agent SDK judges (structured Decision)
        │        → card stored (sqlite) → notification + Inbox
        └─ Local HTTP UI (127.0.0.1 only)
             /inbox → approve / edit / execute / ignore
             /review/<id> → PR per-point review → one COMMENT review
```

- **Judging** (read): Claude Agent SDK. For a PR it gets a shallow local checkout of the PR head with read-only Grep/Read/Glob (never Bash); otherwise scoped read-only GitHub API tools.
- **Fetch + write-back** (read/write): Octokit; writes fire only after human confirmation.
- **State**: a single `node:sqlite` file (cursor + dedupe fingerprints + pending decisions); cards keep working across restarts.

## Install

```bash
npm install   # pure-JS deps, no native build (Electron binary downloads on install)
npm run app
```

Requires **Node.js ≥ 22** (uses the built-in `node:sqlite` and native TypeScript execution).

**All configuration happens in the app** — no config files, no env vars. On first launch the window opens the **settings panel**: repos to watch, GitHub token, poll interval, model, reminders. Settings persist in the app's sqlite state (macOS: `~/Library/Application Support/gh-triage/`).

### Auth (set on the settings panel)

- **GitHub token** — PAT / App token; **must have write access to the watched repos** (it posts comments, closes issues, submits reviews).
- **Claude (judging)** — leave the Claude token empty to use your machine's **Claude Code login** (run `claude login` once; billed to your Claude subscription). Or paste a token: `sk-ant-…` is used as an API key, anything else as a Claude Code OAuth token (from `claude setup-token`).

## Run

```bash
npm run app        # desktop app: tray + notifications + Inbox window
npm run headless   # no shell; prints a tokened URL — configure and confirm in a browser
npm run poll-once  # single cycle: judge + store, then exit (needs settings in the DB)
npm run typecheck  # tsc type check
```

The local UI (127.0.0.1 only) is gated by a per-install session token; only the app window (or the printed headless URL) can reach it.

## Build a distributable app

```bash
npm run pack   # unpacked .app for quick testing → dist/mac-arm64/GitTriage.app
npm run dist   # installers → dist/GitTriage-<version>-arm64.dmg + .zip (Linux: AppImage/deb)
```

Notes:

- The build ships the sources as-is (no compile step; Electron's Node runs the `.ts` directly) with **asar disabled** — the Agent SDK's CLI must exist as a real file so the judge can spawn it.
- Builds are **unsigned** unless you have a Developer ID certificate; on another Mac, Gatekeeper will require right-click → Open the first time (or sign/notarize via electron-builder's standard options).
- First launch on a machine still needs a Claude Code login (`claude login`) unless you paste a token in settings.

## Using the Inbox

> Reply drafts are bilingual: the text **posted to GitHub is English** (`draftReply` / each review point's `comment`), and a parallel **Chinese** version is shown only to help you understand — it is never posted.

- **Reply needed (issue)**: the card shows the draft in an editable textarea — `✅ 批准并回复` posts it (edited text wins), `🚫 忽略` dismisses.
- **Reply needed (PR)**: the card links to the **review page**: each point shows severity / `file:line` / comment / evidence / code snippet; tick the ones to adopt and submit as **one `COMMENT` review** — anchored points become inline comments, the rest fall into the review body (nothing is dropped, GitHub never 422s).
- **No reply needed**: shows the suggested action + rationale; `✅ 执行` runs it (approve / close / label …).
- Cards land with a native notification; the tray shows the open-card count. While a card stays un-actioned the app nudges every `reminder_after_hours` until you handle it.

Supported actions: post a comment, close an issue, approve a PR, request changes on a PR, close a PR, add labels.

## Roadmap

- Keychain storage for tokens (currently in the local sqlite state, plaintext like the old `.env`).
- Packaged builds (electron-builder; asar path handling for the Agent SDK CLI).
- Mobile clients connecting to this core remotely (the Agent SDK cannot run on iOS/Android).
