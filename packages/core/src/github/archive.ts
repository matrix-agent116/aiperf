import { getOctokit } from "./client.ts";
import type { Store, ArchiveItem, TimelineEntry } from "../store.ts";

const MAX_ENTRY_BODY = 4000; // per comment/review body kept locally
const MAX_TIMELINE = 400; // safety cap on entries per item
const ITEM_DELAY_MS = 60; // small breather between items (secondary rate limits)

/**
 * Sync a repo's issue/PR history into the local archive (metadata + full
 * conversation timeline). One mechanism covers both the initial full backfill
 * and later incremental syncs: we walk `state=all` ascending by updated_at
 * starting from the stored cursor, and persist the cursor after every item —
 * so a rate-limit abort or restart resumes where it left off, and a re-run
 * with an up-to-date cursor only touches items that changed since.
 *
 * Returns the numbers of items that were CLOSED during this sync so the
 * caller (engine) can auto-archive any open cards that point at them.
 */
export async function syncRepoArchive(
  owner: string,
  repo: string,
  store: Store,
  log: (line: string) => void = console.log,
): Promise<{ closed: { itemType: "issue" | "pull_request"; number: number }[] }> {
  const gh = getOctokit();
  const repoKey = `${owner}/${repo}`;
  const state = store.getArchiveSync(repoKey);
  let cursor = state?.cursor ?? null;
  let synced = state?.synced ?? 0;
  const closed: { itemType: "issue" | "pull_request"; number: number }[] = [];

  store.setArchiveSync(repoKey, { status: "running", error: undefined });

  const iterator = gh.paginate.iterator(gh.rest.issues.listForRepo, {
    owner,
    repo,
    state: "all",
    sort: "updated",
    direction: "asc",
    per_page: 100,
    ...(cursor ? { since: cursor } : {}),
  });

  try {
    for await (const { data } of iterator) {
      for (const issue of data) {
        const isPR = !!issue.pull_request;
        const itemType = isPR ? ("pull_request" as const) : ("issue" as const);

        const timeline = await fetchTimeline(owner, repo, issue.number, isPR);
        const item: ArchiveItem = {
          repoKey,
          itemType,
          number: issue.number,
          state: issue.state === "closed" ? "closed" : "open",
          merged: !!issue.pull_request?.merged_at,
          title: issue.title,
          author: issue.user?.login ?? "unknown",
          htmlUrl: issue.html_url,
          labels: (issue.labels ?? []).map((l) =>
            typeof l === "string" ? l : (l.name ?? ""),
          ),
          body: clipBody(issue.body ?? ""),
          timeline,
          commentCount: timeline.length,
          ghCreatedAt: issue.created_at,
          ghClosedAt: issue.closed_at ?? null,
          ghUpdatedAt: issue.updated_at,
        };
        store.upsertArchiveItem(item);
        if (item.state === "closed") {
          closed.push({ itemType, number: issue.number });
        }

        synced++;
        // updated_at ascending → this is a safe resume point after EVERY item.
        cursor = issue.updated_at;
        store.setArchiveSync(repoKey, { cursor, synced });
        if (synced % 50 === 0) log(`[archive] ${repoKey}: ${synced} items synced`);
        await sleep(ITEM_DELAY_MS);
      }
    }
    store.setArchiveSync(repoKey, { status: "done", backfilled: true, synced });
    log(`[archive] ${repoKey}: sync complete (${synced} items total)`);
  } catch (e) {
    // Typical: GitHub rate limit. The cursor is already persisted per item, so
    // the next run (manual or after the next poll cycle) resumes right here.
    const message = (e as Error).message;
    store.setArchiveSync(repoKey, { status: "error", error: message, synced });
    log(`[archive] ${repoKey}: sync interrupted (${message}) — will resume from cursor`);
  }

  return { closed };
}

/** Full conversation: issue comments + (for PRs) submitted reviews, oldest first. */
async function fetchTimeline(
  owner: string,
  repo: string,
  number: number,
  isPR: boolean,
): Promise<TimelineEntry[]> {
  const gh = getOctokit();
  const entries: TimelineEntry[] = [];

  const comments = await gh.paginate(gh.rest.issues.listComments, {
    owner,
    repo,
    issue_number: number,
    per_page: 100,
  });
  for (const c of comments) {
    entries.push({
      kind: "comment",
      author: c.user?.login ?? "unknown",
      createdAt: c.created_at,
      body: clipBody(c.body ?? ""),
    });
  }

  if (isPR) {
    const reviews = await gh.paginate(gh.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    });
    for (const r of reviews) {
      if (!r.submitted_at) continue;
      entries.push({
        kind: "review",
        author: r.user?.login ?? "unknown",
        createdAt: r.submitted_at,
        body: clipBody(r.body ?? ""),
        reviewState: r.state,
      });
    }
    // Inline code comments (anchored to diff lines) — GitHub shows these in the
    // PR conversation; without them the local history reads emptier than the page.
    const inline = await gh.paginate(gh.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    });
    for (const c of inline) {
      entries.push({
        kind: "review_comment",
        author: c.user?.login ?? "unknown",
        createdAt: c.created_at,
        body: clipBody(c.body ?? ""),
        path: c.path,
        line: c.line ?? c.original_line ?? null,
        // GitHub shows the anchored code with the comment; keep the hunk header
        // plus the last few lines (what the conversation view displays).
        diffHunk: clipHunk(c.diff_hunk ?? ""),
      });
    }
  }

  entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return entries.slice(0, MAX_TIMELINE);
}

/** Hunk header + at most the last 8 lines — GitHub's conversation view shows the tail. */
function clipHunk(hunk: string): string {
  if (!hunk) return "";
  const lines = hunk.split("\n");
  const header = lines[0]?.startsWith("@@") ? [lines[0]] : [];
  const rest = lines.slice(header.length);
  return [...header, ...rest.slice(-8)].join("\n");
}

function clipBody(s: string): string {
  return s.length > MAX_ENTRY_BODY ? s.slice(0, MAX_ENTRY_BODY) + "\n...(truncated)..." : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
