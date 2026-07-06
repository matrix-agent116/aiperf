# gh-triage-agent

A config-driven, multi-repo, **human-in-the-loop** GitHub issue/PR triage agent.

It watches the repos listed in `config.yaml`, uses Claude to judge issues/PRs opened by **others** — "does this need a reply?" and "what's the next action?" — then pushes the decision + context to **Telegram**. Every write to GitHub (posting a comment, closing an issue, approving/rejecting a PR, adding labels) **happens only after you confirm it from Telegram (or the review page)** — the bot never acts on its own.

## Why not just another GitHub Action

Existing open-source options (`anthropics/claude-code-action`, Issue AI Agent, `Elifterminal/pr-triage`) are almost all GitHub Actions: bound to a single repo, event-triggered, with the AI commenting directly. This project is the opposite: one long-running process that centrally polls many repos, and routes every decision through a human before writing back to GitHub.

## Architecture

```
Long-running Node process
├─ Poll loop (every N minutes)
│   Octokit fetches issues/PRs opened by others, updated after the cursor
│     → Claude Agent SDK judges (structured Decision)
│       → push to Telegram (inline buttons) → store pending + advance cursor
└─ Telegram loop (grammy long polling)
    button callbacks / edited text → Octokit writes back to GitHub → edit the card with a receipt
```

- **Judging** (read): Claude Agent SDK, pure reasoning with no tools; the poller assembles the full context.
- **Fetch + write-back** (read/write): Octokit; writes fire only after human confirmation.
- **State**: a single `node:sqlite` file (cursor + dedupe fingerprints + pending decisions); buttons keep working across restarts.

## Install

```bash
npm install          # pure-JS deps, no native build
cp .env.example .env # fill in the 3 tokens
cp config.example.yaml config.yaml
```

Requires **Node.js ≥ 22** (uses the built-in `node:sqlite` and native TypeScript execution). Verified on Node 26.

### Environment variables (`.env`)

| Variable | Notes |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | **For judging, recommended.** Generate it with `claude setup-token`; uses your Claude Code subscription, no API key needed. |
| `GITHUB_TOKEN` | PAT / App token — **must have write access to the watched repos**. |
| `TELEGRAM_BOT_TOKEN` | Create one via [@BotFather](https://t.me/BotFather). |

> Judging runs through the Claude Agent SDK (which drives the bundled Claude Code binary). Two auth options:
> - **`CLAUDE_CODE_OAUTH_TOKEN`** (recommended) — from `claude setup-token`, billed to your subscription; or
> - `ANTHROPIC_API_KEY` — billed per API usage.
> If both are set the API key overrides the OAuth token — keep only one.

> ⚠️ Because it needs to close issues / review PRs, the watched repos must be ones you have write access to (maintainer/collaborator).

### Config (`config.yaml`)

```yaml
poll_interval_minutes: 5
model: claude-opus-4-8
telegram:
  chat_id: "123456789"        # find your chat_id via @userinfobot
lookback_days_on_first_run: 7 # first poll only looks back this many days, not the whole history
reminder_after_hours: 24      # nudge every N hours while a card is un-actioned; 0 disables
http:                         # draft/review pages served by this service; cards carry only a link
  port: 8787
  base_url: "http://localhost:8787"  # externally reachable address; defaults to http://localhost:<port>
repos:
  - url: https://github.com/owner/repo
    watch: [issues, pulls]
    only_from_others: true    # only items from non-maintainers (by author_association)
    ignore_authors: []        # extra authors to ignore (e.g. your own bot)
```

## Run

```bash
npm start          # long-running daemon (polling + Telegram long polling)
npm run poll-once  # single cycle: judge + push, then exit (for testing the pipeline)
npm run typecheck  # tsc type check
```

## Telegram interaction

- **Reply needed (issue)**: the card's "💬 draft reply" is a link (`http.base_url` + `/reply/<id>`, showing the full draft); buttons `✅ Approve & reply` / `✏️ Edit` / `🚫 Ignore`.
  - Tap Edit, then send a plain text message — the bot posts **that text** as a comment on the issue; the receipt includes the comment link.
- **Reply needed (PR)**: judging produces **per-line review points anchored to the code**. The card shows a URL button `🔎 Review & submit` (+ `🚫 Ignore`) that opens the **rich review page** (`/review/<id>?t=<token>`):
  - Each point shows severity / `file:line` / comment / evidence / the matching code snippet; tick the ones to adopt.
  - On submit it's sent as **one `COMMENT` review**: points that anchor to a changed line become **inline comments**; the rest fall into the **review body** (nothing is dropped, and GitHub never 422s).
  - After a successful submit the Telegram card is finalized with a link to the review.
  - The page link is token-gated (one token per card) — whoever has the link can view and submit.
- **No reply needed**: shows the suggested action + rationale, buttons `✅ Do <action>` / `🚫 Ignore` (`pulls.createReview` APPROVE / REQUEST_CHANGES, etc.).
- After any action the card's buttons are removed and a receipt is appended (✅ replied / ✅ PR review submitted / ✅ closed …) to prevent double taps.
- Pages are served by the daemon's built-in HTTP service (started with `npm start`, listening on `http.port`); `npm run poll-once` does not start it, so the links won't open.

Supported actions: post a comment, close an issue, approve a PR, request changes on a PR, close a PR, add labels.

### Overdue reminders

While a card stays un-actioned, the bot **nudges every `reminder_after_hours` (default 24h)** — a reply under the original card showing how long it's been pending — until you handle it; it stops once actioned (replied/executed/ignored). The check runs at the poll interval; `reminder_after_hours: 0` disables it.

### Dedupe for the same item

- Already-pushed issues/PRs aren't pushed again (deduped by a `number@updated_at` fingerprint, persisted, survives restarts).
- Un-actioned and **no new activity** → not re-pushed; it just waits for you.
- Un-actioned but the issue/PR **got a new comment / was edited** (`updated_at` changed) → it's re-judged and a fresh card is pushed, and the **stale card is auto-cancelled** (buttons removed, marked superseded) so only the newest card for an item stays actionable.
- Items that **fail** to judge or push are not marked processed, and are retried next cycle rather than silently dropped.

## Layout

```
src/
  index.ts            # entry: poll loop + telegram loop
  config.ts           # load + zod-validate config.yaml
  store.ts            # node:sqlite persistence
  server.ts           # built-in HTTP service: issue draft page + PR review page/submit
  diff.ts             # unified-diff parsing (line numbers / commentable lines)
  types.ts            # TriageItem / PrContext
  github/
    client.ts         # Octokit singleton
    poller.ts         # fetch + assemble the judging payload
    actions.ts        # write back to GitHub
  judge/
    judge.ts          # Claude Agent SDK call + JSON-parse retry
    prompt.ts         # judging prompt
    schema.ts         # zod schema for Decision
  telegram/
    bot.ts            # grammy bot + callback / edited-text handling
    render.ts         # Decision → Telegram message + buttons
```
