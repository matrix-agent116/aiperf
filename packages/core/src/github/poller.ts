import type { AppConfig, RepoConfig } from "../config.ts";
import type { Store } from "../store.ts";
import { itemKey, type TriageItem } from "../types.ts";
import { getOctokit, getSelfLogin } from "./client.ts";

const MAX_BODY = 8000;
const MAX_COMMENTS = 10;
const MAX_DIFF = 1_000_000; // total inline diff budget fed to the model (it can get_file the rest)
const MAX_FILES = 3000; // cap on changed files fetched for a PR (GitHub's own max)
const MAX_PAGES = 5; // max pages per repo per cycle, guards against huge first-run pulls

/** Authors with these associations count as maintainers; skipped when only_from_others */
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Fetch a repo's issues/PRs opened by others and updated after the cursor, assembled
 * into TriageItems. Skips items already in the `processed` table, but does NOT mark
 * fingerprints or advance the cursor here — the caller does that only after a
 * successful push, so a failed judge/send is retried next cycle instead of dropped.
 * Returns the items to judge plus `maxSeen` (newest updated_at seen this poll) so the
 * caller can advance the cursor when nothing failed.
 */
export async function pollRepo(
  app: AppConfig,
  rc: RepoConfig,
  store: Store,
): Promise<{ items: TriageItem[]; maxSeen: string }> {
  const gh = getOctokit();
  const repoKey = `${rc.owner}/${rc.repo}`;

  // Our own login: when the last activity on an item is us (a reply/action this agent
  // posted through GITHUB_TOKEN), that self-bump must not re-trigger processing.
  const self = await getSelfLogin();

  const cursor = store.getCursor(repoKey);
  const since =
    cursor ??
    new Date(
      Date.now() - app.lookback_days_on_first_run * 24 * 60 * 60 * 1000,
    ).toISOString();

  const items: TriageItem[] = [];
  let maxUpdatedAt = since;

  // issues.listForRepo returns both issues and PRs (PRs carry a pull_request field)
  const iterator = gh.paginate.iterator(gh.rest.issues.listForRepo, {
    owner: rc.owner,
    repo: rc.repo,
    state: "open",
    since,
    sort: "updated",
    direction: "asc",
    per_page: 100,
  });

  let pages = 0;
  for await (const { data } of iterator) {
    if (++pages > MAX_PAGES) break;
    for (const issue of data) {
      if (issue.updated_at > maxUpdatedAt) maxUpdatedAt = issue.updated_at;

      const isPR = !!issue.pull_request;
      const wantsIssue = !isPR && rc.watch.includes("issues");
      const wantsPR = isPR && rc.watch.includes("pulls");
      if (!wantsIssue && !wantsPR) continue;

      const author = issue.user?.login ?? "unknown";
      if (rc.ignore_authors.includes(author)) continue;
      if (author.endsWith("[bot]")) continue;
      if (
        rc.only_from_others &&
        issue.author_association &&
        MAINTAINER_ASSOCIATIONS.has(issue.author_association)
      ) {
        continue;
      }

      // Dedupe: never process the same item at the same updated_at twice
      const fingerprint = `${itemKey({
        owner: rc.owner,
        repo: rc.repo,
        itemType: isPR ? "pull_request" : "issue",
        number: issue.number,
      })}@${issue.updated_at}`;
      if (store.isProcessed(fingerprint)) continue;

      const comments = await fetchRecentComments(rc, issue.number);

      // Skip items whose latest activity is our own reply/action — otherwise the
      // updated_at bump from posting through GITHUB_TOKEN re-triggers this same item
      // next cycle (duplicate cards / a self-reply loop). A newer comment/review by
      // someone else, or a newer commit on a PR, still counts as real new activity.
      if (
        self &&
        (await lastActorIsSelf(
          rc,
          { number: issue.number, openedBy: author, createdAt: issue.created_at },
          isPR,
          comments,
          self,
        ))
      ) {
        continue;
      }

      const base: TriageItem = {
        owner: rc.owner,
        repo: rc.repo,
        itemType: isPR ? "pull_request" : "issue",
        number: issue.number,
        title: issue.title,
        body: truncate(issue.body ?? "", MAX_BODY),
        author,
        htmlUrl: issue.html_url,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        state: issue.state,
        labels: (issue.labels ?? []).map((l) =>
          typeof l === "string" ? l : (l.name ?? ""),
        ),
        comments,
      };

      if (isPR) {
        Object.assign(base, await fetchPrDetails(rc, issue.number));
      }

      // Note: fingerprint is marked processed by the caller only after a successful
      // push, so an item that fails to judge/send is picked up again next cycle.
      items.push(base);
    }
  }

  return { items, maxSeen: maxUpdatedAt };
}

async function fetchRecentComments(rc: RepoConfig, number: number) {
  const gh = getOctokit();
  const { data } = await gh.rest.issues.listComments({
    owner: rc.owner,
    repo: rc.repo,
    issue_number: number,
    per_page: MAX_COMMENTS,
    sort: "created",
    direction: "desc",
  });
  return data
    .reverse()
    .map((c) => ({
      author: c.user?.login ?? "unknown",
      body: truncate(c.body ?? "", 1500),
      createdAt: c.created_at,
    }));
}

/**
 * True when the most recent activity on the item was performed by `self` (the
 * GITHUB_TOKEN user) — i.e. the update was our own reply/review/action, not something
 * new to respond to. Looks at the newest comment, and for a PR also the newest review
 * and newest commit: a commit newer than our last reply is real new work, so we never
 * skip in that case regardless of who pushed it.
 */
async function lastActorIsSelf(
  rc: RepoConfig,
  issue: { number: number; openedBy: string; createdAt: string },
  isPR: boolean,
  comments: { author: string; createdAt: string }[],
  self: string,
): Promise<boolean> {
  const newest = comments[comments.length - 1];
  let actor = newest ? newest.author : issue.openedBy;
  let at = newest ? newest.createdAt : issue.createdAt;

  if (isPR) {
    const review = await fetchLatestReview(rc, issue.number);
    if (review && review.submittedAt >= at) {
      actor = review.author;
      at = review.submittedAt;
    }
    const commitAt = await fetchLatestCommitDate(rc, issue.number);
    // A commit pushed after our last reply is new code to (re)review — don't skip.
    if (commitAt && commitAt > at) return false;
  }

  return actor === self;
}

async function fetchLatestReview(
  rc: RepoConfig,
  number: number,
): Promise<{ author: string; submittedAt: string } | null> {
  const gh = getOctokit();
  try {
    const reviews = await gh.paginate(gh.rest.pulls.listReviews, {
      owner: rc.owner,
      repo: rc.repo,
      pull_number: number,
      per_page: 100,
    });
    let latest: { author: string; submittedAt: string } | null = null;
    for (const r of reviews) {
      if (!r.submitted_at) continue;
      if (!latest || r.submitted_at > latest.submittedAt) {
        latest = { author: r.user?.login ?? "", submittedAt: r.submitted_at };
      }
    }
    return latest;
  } catch (e) {
    console.warn(`[poll] failed to list reviews for #${number}:`, (e as Error).message);
    return null;
  }
}

async function fetchLatestCommitDate(rc: RepoConfig, number: number): Promise<string | null> {
  const gh = getOctokit();
  try {
    const commits = await gh.paginate(gh.rest.pulls.listCommits, {
      owner: rc.owner,
      repo: rc.repo,
      pull_number: number,
      per_page: 100,
    });
    let latest: string | null = null;
    for (const c of commits) {
      const at = c.commit?.committer?.date ?? c.commit?.author?.date;
      if (at && (!latest || at > latest)) latest = at;
    }
    return latest;
  } catch (e) {
    console.warn(`[poll] failed to list commits for #${number}:`, (e as Error).message);
    return null;
  }
}

async function fetchPrDetails(
  rc: RepoConfig,
  number: number,
): Promise<Partial<TriageItem>> {
  const gh = getOctokit();
  const [pr, allFiles] = await Promise.all([
    gh.rest.pulls.get({ owner: rc.owner, repo: rc.repo, pull_number: number }),
    gh.paginate(gh.rest.pulls.listFiles, {
      owner: rc.owner,
      repo: rc.repo,
      pull_number: number,
      per_page: 100,
    }),
  ]);
  const files = allFiles.slice(0, MAX_FILES);

  // Include as many per-file patches inline as fit the budget (skip, don't stop,
  // so a huge early file doesn't starve the rest). Files not shown inline are
  // still listed in changedFiles so the model can get_file them.
  const structured: { path: string; patch: string }[] = [];
  let used = 0;
  for (const f of files) {
    if (f.patch && used + f.patch.length <= MAX_DIFF) {
      structured.push({ path: f.filename, patch: f.patch });
      used += f.patch.length;
    }
  }
  const shown = new Set(structured.map((s) => s.path));
  const changedFiles = files.map((f) => ({
    path: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    shown: shown.has(f.filename),
  }));

  const fileLines = files
    .map((f) => `  ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`)
    .join("\n");
  const header =
    `${files.length} files changed, +${pr.data.additions}/-${pr.data.deletions}` +
    (pr.data.draft ? " (draft)" : "");

  return {
    isDraft: pr.data.draft ?? false,
    diffSummary: `${header}\n${fileLines}`.trim(),
    files: structured,
    changedFiles,
    headRef: pr.data.head.sha,
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n...(truncated)..." : s;
}
