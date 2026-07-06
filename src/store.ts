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
  chatId: string;
  messageId: number | null;
  status: PendingStatus;
  createdAt: number;
  remindedAt: number | null;
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
  message_id: number | null;
  status: string;
  created_at: number;
  reminded_at: number | null;
  token: string;
  context_json: string | null;
}

// Columns for lookups that don't need the (potentially large) diff context — avoids
// reading/parsing context_json on every background sweep. NULL AS context_json keeps
// rowToPending happy (it maps to context: null).
const COLS_NO_CTX =
  "id, owner, repo, item_type, number, html_url, title, decision_json, draft_reply, chat_id, message_id, status, created_at, reminded_at, token, NULL AS context_json";

/**
 * Persistence:
 *  - cursors: last poll timestamp per repo
 *  - processed: fingerprints of already-handled (item + updated_at), dedupe guard
 *  - pending: decisions pushed to Telegram, awaiting human confirmation
 */
export class Store {
  private db: DatabaseSync;

  constructor(path = process.env.DB_PATH ?? "./data/state.db") {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
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
        message_id INTEGER,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        reminded_at INTEGER,
        token TEXT NOT NULL DEFAULT '',
        context_json TEXT
      );
    `);
    // Migrate DBs created before these columns existed.
    this.ensureColumn("pending", "reminded_at", "INTEGER");
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
    input: Omit<
      PendingDecision,
      "id" | "messageId" | "status" | "createdAt" | "remindedAt" | "token"
    >,
  ): PendingDecision {
    const id = randomBytes(6).toString("base64url"); // short, fits Telegram's 64-byte callback_data limit
    const record: PendingDecision = {
      ...input,
      id,
      token: randomBytes(12).toString("base64url"), // review-page secret
      messageId: null,
      status: "pending",
      createdAt: Date.now(),
      remindedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO pending
           (id, owner, repo, item_type, number, html_url, title,
            decision_json, draft_reply, chat_id, message_id, status, created_at,
            token, context_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        record.chatId,
        record.messageId,
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

  setPendingMessageId(id: string, messageId: number): void {
    this.db
      .prepare("UPDATE pending SET message_id = ? WHERE id = ?")
      .run(messageId, id);
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

  /**
   * Shown cards still open (pending / awaiting_edit) whose last reminder — or
   * creation, if never reminded — is older than `beforeMs`. Drives repeating
   * nudges: re-fires every interval until the card is actioned.
   */
  findDueReminders(beforeMs: number): PendingDecision[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLS_NO_CTX} FROM pending
         WHERE status IN ('pending', 'awaiting_edit')
           AND message_id IS NOT NULL
           AND COALESCE(reminded_at, created_at) < ?`,
      )
      .all(beforeMs) as unknown as PendingRow[];
    return rows.map(rowToPending);
  }

  markReminded(id: string): void {
    this.db
      .prepare("UPDATE pending SET reminded_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  /** The pending item in a chat currently awaiting edited reply text (at most one) */
  findAwaitingEdit(chatId: string): PendingDecision | null {
    const row = this.db
      .prepare(
        `SELECT ${COLS_NO_CTX} FROM pending WHERE chat_id = ? AND status = 'awaiting_edit' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(chatId) as PendingRow | undefined;
    return row ? rowToPending(row) : null;
  }

  close(): void {
    this.db.close();
  }
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
    chatId: row.chat_id,
    messageId: row.message_id,
    status: row.status as PendingStatus,
    createdAt: row.created_at,
    remindedAt: row.reminded_at,
    token: row.token,
    context: row.context_json
      ? (JSON.parse(row.context_json) as PrContext)
      : null,
  };
}
