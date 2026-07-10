import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { Decision } from "./judge/schema.ts";
import type { PrContext } from "./types.ts";

export type PendingStatus =
  | "pending"
  | "awaiting_edit"
  | "replied"
  | "executed"
  | "ignored"
  | "superseded";

export interface PendingDecision {
  id: string;
  owner: string;
  repo: string;
  itemType: "issue" | "pull_request";
  number: number;
  htmlUrl: string;
  title: string;
  decision: Decision;
  draftReply: string | null;
  status: PendingStatus;
  createdAt: number;
  /** secret in the review-page URL; whoever has it can view + submit */
  token: string;
  /** PR only: persisted patches for rendering the review page */
  context: PrContext | null;
}

interface PendingRow {
  id: string;
  owner: string;
  repo: string;
  item_type: string;
  number: number;
  html_url: string;
  title: string;
  decision_json: string;
  draft_reply: string | null;
  chat_id: string;
  status: string;
  created_at: number;
  token: string;
  context_json: string | null;
}

// Columns for lookups that don't need the (potentially large) diff context — avoids
// reading/parsing context_json on every background sweep. NULL AS context_json keeps
// rowToPending happy (it maps to context: null).
const COLS_NO_CTX =
  "id, owner, repo, item_type, number, html_url, title, decision_json, draft_reply, chat_id, status, created_at, token, NULL AS context_json";

/**
 * Persistence:
 *  - cursors: last poll timestamp per repo
 *  - processed: fingerprints of already-handled (item + updated_at), dedupe guard
 *  - pending: judged decisions surfaced to the human, awaiting confirmation
 */
export class Store {
  private db: DatabaseSync;

  constructor(path = process.env.DB_PATH ?? "./data/state.db") {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cursors (
        repo TEXT PRIMARY KEY,
        last_polled_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed (
        fingerprint TEXT PRIMARY KEY,
        processed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        item_type TEXT NOT NULL,
        number INTEGER NOT NULL,
        html_url TEXT NOT NULL,
        title TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        draft_reply TEXT,
        chat_id TEXT NOT NULL,
        message_id INTEGER,   -- legacy (Telegram-era delivery marker), unused
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        reminded_at INTEGER,  -- legacy (removed reminder feature), unused
        token TEXT NOT NULL DEFAULT '',
        context_json TEXT
      );
      CREATE TABLE IF NOT EXISTS repo_analysis (
        repo_key TEXT PRIMARY KEY,   -- "owner/repo"
        status TEXT NOT NULL,        -- running | done | error
        json TEXT,                   -- RepoAnalysis (status=done)
        error TEXT,                  -- message (status=error)
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS archive_items (
        repo_key TEXT NOT NULL,      -- "owner/repo"
        item_type TEXT NOT NULL,     -- issue | pull_request
        number INTEGER NOT NULL,
        state TEXT NOT NULL,         -- open | closed
        merged INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        html_url TEXT NOT NULL DEFAULT '',
        labels_json TEXT NOT NULL DEFAULT '[]',
        body TEXT NOT NULL DEFAULT '',
        timeline_json TEXT NOT NULL DEFAULT '[]',
        comment_count INTEGER NOT NULL DEFAULT 0,
        gh_created_at TEXT NOT NULL DEFAULT '',
        gh_closed_at TEXT,
        gh_updated_at TEXT NOT NULL DEFAULT '',
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (repo_key, item_type, number)
      );
      CREATE INDEX IF NOT EXISTS idx_archive_repo_state
        ON archive_items(repo_key, state, gh_closed_at);
      CREATE TABLE IF NOT EXISTS archive_sync (
        repo_key TEXT PRIMARY KEY,
        status TEXT NOT NULL,        -- running | done | error
        cursor TEXT,                 -- newest gh_updated_at fully processed (resume point)
        backfilled INTEGER NOT NULL DEFAULT 0,  -- 1 once the initial full pass completed
        synced INTEGER NOT NULL DEFAULT 0,      -- items upserted across all runs
        error TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    // Migrate DBs created before these columns existed.
    this.ensureColumn("pending", "token", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("pending", "context_json", "TEXT");
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as unknown as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  // ---- app settings (edited on the settings page; single JSON document) ----
  getSettingsRaw(): unknown | null {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'app'")
      .get() as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  saveSettingsRaw(value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('app', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(value));
  }

  /**
   * Session token gating the whole local web UI: only the app's own window (whose
   * URL carries it) can reach the pages, not arbitrary local processes. Persisted
   * so headless users can bookmark the URL across restarts.
   */
  getOrCreateUiToken(): string {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'ui_token'")
      .get() as { value: string } | undefined;
    if (row) return row.value;
    const token = randomBytes(16).toString("base64url");
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('ui_token', ?)")
      .run(token);
    return token;
  }

  // ---- cursors ----
  getCursor(repo: string): string | null {
    const row = this.db
      .prepare("SELECT last_polled_at FROM cursors WHERE repo = ?")
      .get(repo) as { last_polled_at: string } | undefined;
    return row?.last_polled_at ?? null;
  }

  setCursor(repo: string, iso: string): void {
    this.db
      .prepare(
        `INSERT INTO cursors (repo, last_polled_at) VALUES (?, ?)
         ON CONFLICT(repo) DO UPDATE SET last_polled_at = excluded.last_polled_at`,
      )
      .run(repo, iso);
  }

  // ---- dedupe fingerprints (itemKey + updatedAt) ----
  isProcessed(fingerprint: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM processed WHERE fingerprint = ?")
      .get(fingerprint);
  }

  markProcessed(fingerprint: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO processed (fingerprint, processed_at) VALUES (?, ?)",
      )
      .run(fingerprint, Date.now());
  }


  // ---- pending decisions ----
  createPending(
    input: Omit<PendingDecision, "id" | "status" | "createdAt" | "token">,
  ): PendingDecision {
    const id = randomBytes(6).toString("base64url"); // short, URL-friendly
    const record: PendingDecision = {
      ...input,
      id,
      token: randomBytes(12).toString("base64url"), // review-page secret
      status: "pending",
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO pending
           (id, owner, repo, item_type, number, html_url, title,
            decision_json, draft_reply, chat_id, status, created_at,
            token, context_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.owner,
        record.repo,
        record.itemType,
        record.number,
        record.htmlUrl,
        record.title,
        JSON.stringify(record.decision),
        record.draftReply,
        // chat_id survives as a legacy NOT NULL column from the Telegram era
        "",
        record.status,
        record.createdAt,
        record.token,
        record.context ? JSON.stringify(record.context) : null,
      );
    return record;
  }

  getPending(id: string): PendingDecision | null {
    const row = this.db
      .prepare("SELECT * FROM pending WHERE id = ?")
      .get(id) as PendingRow | undefined;
    return row ? rowToPending(row) : null;
  }

  setPendingStatus(id: string, status: PendingStatus): void {
    this.db.prepare("UPDATE pending SET status = ? WHERE id = ?").run(status, id);
  }

  setPendingDraft(id: string, draftReply: string): void {
    this.db
      .prepare("UPDATE pending SET draft_reply = ? WHERE id = ?")
      .run(draftReply, id);
  }

  /**
   * Still-open (pending / awaiting_edit) cards for the same issue/PR, excluding
   * `exceptId`. Used to cancel a stale card when a fresher one is pushed.
   */
  findOpenForItem(
    owner: string,
    repo: string,
    itemType: PendingDecision["itemType"],
    number: number,
    exceptId: string,
  ): PendingDecision[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLS_NO_CTX} FROM pending
         WHERE owner = ? AND repo = ? AND item_type = ? AND number = ?
           AND id != ? AND status IN ('pending', 'awaiting_edit')`,
      )
      .all(owner, repo, itemType, number, exceptId) as unknown as PendingRow[];
    return rows.map(rowToPending);
  }

  /** Open cards (pending / awaiting_edit) awaiting the human, newest first. */
  listOpen(): PendingDecision[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLS_NO_CTX} FROM pending
         WHERE status IN ('pending', 'awaiting_edit')
         ORDER BY created_at DESC`,
      )
      .all() as unknown as PendingRow[];
    return rows.map(rowToPending);
  }

  /** Most recent cards regardless of status (history view). */
  listRecent(limit = 30): PendingDecision[] {
    const rows = this.db
      .prepare(`SELECT ${COLS_NO_CTX} FROM pending ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as unknown as PendingRow[];
    return rows.map(rowToPending);
  }

  /** Terminal-status cards (the "done" folder in the mail-style UI), newest first. */
  listDone(limit = 100): PendingDecision[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLS_NO_CTX} FROM pending
         WHERE status NOT IN ('pending', 'awaiting_edit')
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as PendingRow[];
    return rows.map(rowToPending);
  }

  /** Per-repo open/done tallies for the sidebar folder tree. */
  countByRepo(): { owner: string; repo: string; open: number; done: number }[] {
    return this.db
      .prepare(
        `SELECT owner, repo,
           SUM(CASE WHEN status IN ('pending', 'awaiting_edit') THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN status NOT IN ('pending', 'awaiting_edit') THEN 1 ELSE 0 END) AS done
         FROM pending GROUP BY owner, repo ORDER BY owner, repo`,
      )
      .all() as unknown as { owner: string; repo: string; open: number; done: number }[];
  }

  countOpen(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM pending WHERE status IN ('pending', 'awaiting_edit')",
      )
      .get() as { n: number };
    return row.n;
  }

  // ---- whole-repo analysis (architecture map + security scan, /repo page) ----

  getRepoAnalysis(repoKey: string): RepoAnalysisRecord | null {
    const row = this.db
      .prepare("SELECT * FROM repo_analysis WHERE repo_key = ?")
      .get(repoKey) as
      | { repo_key: string; status: string; json: string | null; error: string | null; updated_at: number }
      | undefined;
    if (!row) return null;
    return {
      repoKey: row.repo_key,
      status: row.status as RepoAnalysisRecord["status"],
      json: row.json,
      error: row.error,
      updatedAt: row.updated_at,
    };
  }

  setRepoAnalysis(
    repoKey: string,
    status: RepoAnalysisRecord["status"],
    json?: string,
    error?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO repo_analysis (repo_key, status, json, error, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(repo_key) DO UPDATE SET
           status = excluded.status, json = excluded.json,
           error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run(repoKey, status, json ?? null, error ?? null, Date.now());
  }

  // ---- local issue/PR archive (full history, synced from GitHub) ----

  upsertArchiveItem(item: ArchiveItem): void {
    this.db
      .prepare(
        `INSERT INTO archive_items
           (repo_key, item_type, number, state, merged, title, author, html_url,
            labels_json, body, timeline_json, comment_count,
            gh_created_at, gh_closed_at, gh_updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_key, item_type, number) DO UPDATE SET
           state = excluded.state, merged = excluded.merged, title = excluded.title,
           author = excluded.author, html_url = excluded.html_url,
           labels_json = excluded.labels_json, body = excluded.body,
           timeline_json = excluded.timeline_json, comment_count = excluded.comment_count,
           gh_created_at = excluded.gh_created_at, gh_closed_at = excluded.gh_closed_at,
           gh_updated_at = excluded.gh_updated_at, synced_at = excluded.synced_at`,
      )
      .run(
        item.repoKey,
        item.itemType,
        item.number,
        item.state,
        item.merged ? 1 : 0,
        item.title,
        item.author,
        item.htmlUrl,
        JSON.stringify(item.labels),
        item.body,
        JSON.stringify(item.timeline),
        item.commentCount,
        item.ghCreatedAt,
        item.ghClosedAt,
        item.ghUpdatedAt,
        Date.now(),
      );
  }

  getArchiveItem(
    repoKey: string,
    itemType: string,
    number: number,
  ): ArchiveItem | null {
    const row = this.db
      .prepare(
        "SELECT * FROM archive_items WHERE repo_key = ? AND item_type = ? AND number = ?",
      )
      .get(repoKey, itemType, number) as ArchiveRow | undefined;
    return row ? rowToArchive(row) : null;
  }

  /** Closed archive items, newest-closed first, for the 已处理 folder. */
  listClosedArchive(repoKey: string | undefined, limit: number, offset = 0): ArchiveItem[] {
    const where = repoKey ? "repo_key = ? AND state = 'closed'" : "state = 'closed'";
    const args: (string | number)[] = repoKey ? [repoKey] : [];
    const rows = this.db
      .prepare(
        `SELECT * FROM archive_items WHERE ${where}
         ORDER BY gh_closed_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as unknown as ArchiveRow[];
    return rows.map(rowToArchive);
  }

  countClosedArchive(repoKey?: string): number {
    const where = repoKey ? "repo_key = ? AND state = 'closed'" : "state = 'closed'";
    const args = repoKey ? [repoKey] : [];
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM archive_items WHERE ${where}`)
      .get(...args) as { n: number };
    return row.n;
  }

  getArchiveSync(repoKey: string): ArchiveSyncState | null {
    const row = this.db
      .prepare("SELECT * FROM archive_sync WHERE repo_key = ?")
      .get(repoKey) as
      | { repo_key: string; status: string; cursor: string | null; backfilled: number; synced: number; error: string | null; updated_at: number }
      | undefined;
    if (!row) return null;
    return {
      repoKey: row.repo_key,
      status: row.status as ArchiveSyncState["status"],
      cursor: row.cursor,
      backfilled: !!row.backfilled,
      synced: row.synced,
      error: row.error,
      updatedAt: row.updated_at,
    };
  }

  setArchiveSync(
    repoKey: string,
    patch: Partial<Pick<ArchiveSyncState, "status" | "cursor" | "backfilled" | "synced" | "error">>,
  ): void {
    const cur = this.getArchiveSync(repoKey);
    const next = {
      status: patch.status ?? cur?.status ?? "running",
      cursor: patch.cursor !== undefined ? patch.cursor : (cur?.cursor ?? null),
      backfilled: patch.backfilled !== undefined ? patch.backfilled : (cur?.backfilled ?? false),
      synced: patch.synced !== undefined ? patch.synced : (cur?.synced ?? 0),
      error: patch.error !== undefined ? patch.error : null,
    };
    this.db
      .prepare(
        `INSERT INTO archive_sync (repo_key, status, cursor, backfilled, synced, error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_key) DO UPDATE SET
           status = excluded.status, cursor = excluded.cursor,
           backfilled = excluded.backfilled, synced = excluded.synced,
           error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run(
        repoKey,
        next.status,
        next.cursor,
        next.backfilled ? 1 : 0,
        next.synced,
        next.error,
        Date.now(),
      );
  }

  close(): void {
    this.db.close();
  }
}

/** One entry of an item's conversation history (issue comment or PR review). */
export interface TimelineEntry {
  kind: "comment" | "review";
  author: string;
  createdAt: string;
  body: string;
  /** review only: APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED */
  reviewState?: string;
}

/** A locally archived issue/PR: metadata + full conversation timeline. */
export interface ArchiveItem {
  repoKey: string;
  itemType: "issue" | "pull_request";
  number: number;
  state: "open" | "closed";
  merged: boolean;
  title: string;
  author: string;
  htmlUrl: string;
  labels: string[];
  body: string;
  timeline: TimelineEntry[];
  commentCount: number;
  ghCreatedAt: string;
  ghClosedAt: string | null;
  ghUpdatedAt: string;
}

export interface ArchiveSyncState {
  repoKey: string;
  status: "running" | "done" | "error";
  /** newest gh_updated_at fully processed — resume/incremental point */
  cursor: string | null;
  backfilled: boolean;
  synced: number;
  error: string | null;
  updatedAt: number;
}

interface ArchiveRow {
  repo_key: string;
  item_type: string;
  number: number;
  state: string;
  merged: number;
  title: string;
  author: string;
  html_url: string;
  labels_json: string;
  body: string;
  timeline_json: string;
  comment_count: number;
  gh_created_at: string;
  gh_closed_at: string | null;
  gh_updated_at: string;
  synced_at: number;
}

function rowToArchive(row: ArchiveRow): ArchiveItem {
  return {
    repoKey: row.repo_key,
    itemType: row.item_type as ArchiveItem["itemType"],
    number: row.number,
    state: row.state as ArchiveItem["state"],
    merged: !!row.merged,
    title: row.title,
    author: row.author,
    htmlUrl: row.html_url,
    labels: JSON.parse(row.labels_json) as string[],
    body: row.body,
    timeline: JSON.parse(row.timeline_json) as TimelineEntry[],
    commentCount: row.comment_count,
    ghCreatedAt: row.gh_created_at,
    ghClosedAt: row.gh_closed_at,
    ghUpdatedAt: row.gh_updated_at,
  };
}

export interface RepoAnalysisRecord {
  repoKey: string;
  status: "running" | "done" | "error";
  json: string | null;
  error: string | null;
  updatedAt: number;
}

function rowToPending(row: PendingRow): PendingDecision {
  return {
    id: row.id,
    owner: row.owner,
    repo: row.repo,
    itemType: row.item_type as PendingDecision["itemType"],
    number: row.number,
    htmlUrl: row.html_url,
    title: row.title,
    decision: JSON.parse(row.decision_json) as Decision,
    draftReply: row.draft_reply,
    status: row.status as PendingStatus,
    createdAt: row.created_at,
    token: row.token,
    context: row.context_json
      ? (JSON.parse(row.context_json) as PrContext)
      : null,
  };
}
