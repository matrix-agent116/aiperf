import { EventEmitter } from "node:events";
import type { AppConfig } from "./config.ts";
import { Store, type PendingDecision, type PendingStatus } from "./store.ts";
import { pollRepo } from "./github/poller.ts";
import { configureGithub } from "./github/client.ts";
import { judge } from "./judge/judge.ts";
import { postReply, executeSuggestedAction } from "./github/actions.ts";
import { itemKey } from "./types.ts";

/** A card reached a terminal state; `receipt` is a human-readable summary line. */
export interface FinalizedEvent {
  id: string;
  status: PendingStatus;
  receipt: string;
  /** Link to what was created on GitHub, when the action produced one */
  url?: string;
}

interface EngineEvents {
  /** A fresh decision was judged and stored — show it to the human */
  card: [PendingDecision];
  finalized: [FinalizedEvent];
  cycle: [{ phase: "start" | "done" }];
  /** Named pollError (not "error") so an unlistened emit doesn't throw per EventEmitter rules */
  pollError: [{ scope: string; message: string }];
}

/**
 * The heart of the app: drives poll → judge → store, exposes the human-confirmed
 * actions (reply / execute / ignore), and emits events for whatever UI is attached
 * (desktop shell notifications, the local web pages, a headless logger).
 * No GitHub write ever happens except through the explicit action methods below.
 */
export class TriageEngine extends EventEmitter<EngineEvents> {
  private timer: NodeJS.Timeout | null = null;
  private cycleRunning = false;
  private app: AppConfig | null = null;
  private store: Store;

  constructor(store: Store) {
    super();
    this.store = store;
  }

  get configured(): boolean {
    return this.app !== null;
  }

  /**
   * Install (or replace) the user configuration: wires the GitHub token and Claude
   * auth into place, and restarts the poll timer if it was running (so an interval
   * change takes effect immediately).
   */
  setConfig(app: AppConfig): void {
    const prev = this.app;
    const wasRunning = this.timer !== null;
    this.stop();
    this.app = app;
    configureGithub(app.github_token);
    applyClaudeAuth(app.claude_token);
    // Content languages changed → old open cards hold old-language text. Requeue
    // them for re-judging; the fresh cards supersede the stale ones on the next
    // cycle (which start()/pollNow below kicks off immediately).
    if (
      prev &&
      (prev.post_language !== app.post_language ||
        prev.display_language !== app.display_language)
    ) {
      const n = this.requeueOpenCards();
      if (n) {
        console.log(
          `[settings] content languages changed — re-judging ${n} open card(s) in ${app.display_language}/${app.post_language}`,
        );
      }
    }
    if (wasRunning) this.start();
  }

  /**
   * Make every open card's item eligible for re-judging: clear its dedupe
   * fingerprints and rewind the repo cursor to before the card was created
   * (item.updatedAt always precedes the judgment, minus a 1-day safety margin).
   */
  private requeueOpenCards(): number {
    const open = this.store.listOpen();
    if (!open.length) return 0;
    const earliestByRepo = new Map<string, number>();
    for (const p of open) {
      this.store.clearProcessedForItem(itemKey(p));
      const repoKey = `${p.owner}/${p.repo}`;
      const e = earliestByRepo.get(repoKey);
      if (e === undefined || p.createdAt < e) earliestByRepo.set(repoKey, p.createdAt);
    }
    for (const [repoKey, ts] of earliestByRepo) {
      this.store.rewindCursor(repoKey, new Date(ts - 24 * 3600_000).toISOString());
    }
    return open.length;
  }

  /** Run one cycle immediately, then poll on the configured interval. */
  start(): void {
    if (this.timer || !this.app) return;
    void this.pollNow();
    this.timer = setInterval(
      () => void this.pollNow(),
      this.app.poll_interval_minutes * 60 * 1000,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Kick a cycle now (startup, tray menu, wake-from-sleep). Overlapping calls no-op. */
  async pollNow(): Promise<void> {
    if (this.cycleRunning) return;
    this.cycleRunning = true;
    try {
      await this.pollCycle();
    } finally {
      this.cycleRunning = false;
    }
  }

  /** Open cards awaiting the human, newest first. */
  listOpen(): PendingDecision[] {
    return this.store.listOpen();
  }

  countOpen(): number {
    return this.store.countOpen();
  }

  // ---- human-confirmed actions (the ONLY paths that write to GitHub) ----

  /**
   * Approve the draft (optionally edited) and post it: issue → comment,
   * PR → review body (per-point PR submissions go through the review page instead).
   */
  async approveReply(id: string, editedText?: string): Promise<FinalizedEvent> {
    const p = this.mustBeOpen(id);
    const body = (editedText ?? p.draftReply ?? "").trim();
    if (!body) throw new Error("回复内容为空");
    if (editedText) this.store.setPendingDraft(id, editedText);
    const url = await postReply(p, body);
    return this.finalize(id, "replied", p.itemType === "pull_request" ? "✅ 已提交 PR Review" : "✅ 已回复到 GitHub", url);
  }

  /** Execute the judged suggestedAction (close / approve / label …). */
  async executeAction(id: string): Promise<FinalizedEvent> {
    const p = this.mustBeOpen(id);
    const receipt = await executeSuggestedAction(p);
    return this.finalize(id, "executed", receipt);
  }

  ignore(id: string): FinalizedEvent {
    this.mustBeOpen(id);
    return this.finalize(id, "ignored", "🚫 已忽略");
  }

  /** Record a PR review submitted via the review page (the page does the GitHub write). */
  noteReviewSubmitted(id: string, receipt: string, url?: string): FinalizedEvent {
    return this.finalize(id, "replied", receipt, url);
  }

  private mustBeOpen(id: string): PendingDecision {
    const p = this.store.getPending(id);
    if (!p) throw new Error("卡片不存在");
    if (p.status !== "pending" && p.status !== "awaiting_edit") {
      throw new Error("该卡片已处理过");
    }
    return p;
  }

  private finalize(
    id: string,
    status: PendingStatus,
    receipt: string,
    url?: string,
  ): FinalizedEvent {
    this.store.setPendingStatus(id, status);
    const ev: FinalizedEvent = { id, status, receipt, url };
    this.emit("finalized", ev);
    return ev;
  }

  // ---- the poll → judge → store cycle (moved from the old index.ts) ----

  private async pollCycle(): Promise<void> {
    if (!this.app) return;
    const app = this.app;
    this.emit("cycle", { phase: "start" });
    console.log(`[poll] starting cycle over ${app.repos.length} repo(s)`);
    for (const rc of app.repos) {
      const repoKey = `${rc.owner}/${rc.repo}`;
      try {
        const { items, maxSeen } = await pollRepo(app, rc, this.store);
        if (items.length)
          console.log(`[poll] ${repoKey}: ${items.length} item(s) to judge`);

        // Advance the cursor to the newest item seen — unless something failed, in
        // which case hold it at the earliest failure so that item is re-fetched next
        // cycle (already-pushed items are skipped by their processed fingerprint).
        let cursorTarget = maxSeen;

        for (const item of items) {
          const fingerprint = `${itemKey(item)}@${item.updatedAt}`;
          try {
            const decision = await judge(item, app);
            const pending = this.store.createPending({
              owner: item.owner,
              repo: item.repo,
              itemType: item.itemType,
              number: item.number,
              htmlUrl: item.htmlUrl,
              title: item.title,
              decision,
              draftReply: decision.draftReply ?? null,
              // Persist the full changed-file diff for display on the review page.
              // Background sweeps never read this column (see store COLS_NO_CTX),
              // and the page renders it collapsed per file, so the size is fine.
              context:
                item.itemType === "pull_request" && item.files
                  ? { files: item.files }
                  : null,
            });
            this.emit("card", pending);
            this.store.markProcessed(fingerprint); // only after a successful emit

            // The fresh card is out — cancel any older un-actioned card for this item.
            for (const stale of this.store.findOpenForItem(
              item.owner,
              item.repo,
              item.itemType,
              item.number,
              pending.id,
            )) {
              this.finalize(stale.id, "superseded", "🔄 该 issue/PR 有新活动，此卡已被新卡片取代");
            }

            console.log(
              `[poll] pushed ${itemKey(item)} (needsReply=${decision.needsReply}, action=${decision.suggestedAction})`,
            );
          } catch (err) {
            // Don't mark processed; hold the cursor so this item is retried next cycle.
            if (item.updatedAt < cursorTarget) cursorTarget = item.updatedAt;
            const message = (err as Error).message;
            console.error(`[poll] failed to handle ${itemKey(item)}:`, message);
            this.emit("pollError", { scope: itemKey(item), message });
          }
        }

        this.store.setCursor(repoKey, cursorTarget);
      } catch (err) {
        const message = (err as Error).message;
        console.error(`[poll] failed to poll ${repoKey}:`, message);
        this.emit("pollError", { scope: repoKey, message });
      }
    }

    this.emit("cycle", { phase: "done" });
    console.log("[poll] cycle done");
  }
}

/**
 * Wire the Claude auth from settings into the environment the Agent SDK (and its
 * spawned CLI) reads. Empty token = clear overrides and use the machine's Claude
 * Code login. Claude Code OAuth tokens ALSO start with "sk-ant-" (sk-ant-oat01-…),
 * so match their prefix first; only other sk-ant-… tokens are API keys.
 */
function applyClaudeAuth(token: string): void {
  const t = token.trim();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!t) return;
  if (t.startsWith("sk-ant-oat")) process.env.CLAUDE_CODE_OAUTH_TOKEN = t;
  else if (t.startsWith("sk-ant-")) process.env.ANTHROPIC_API_KEY = t;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = t;
}
