import type { AppConfig, RepoConfig } from "../config.ts";
import type { Store } from "../store.ts";
import { itemKey, type TriageItem } from "../types.ts";
import { getOctokit } from "./client.ts";

const MAX_BODY = 6000;
const MAX_COMMENTS = 10;
const MAX_DIFF = 6000;
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

async function fetchPrDetails(
  rc: RepoConfig,
  number: number,
): Promise<Partial<TriageItem>> {
  const gh = getOctokit();
  const [pr, files] = await Promise.all([
    gh.rest.pulls.get({ owner: rc.owner, repo: rc.repo, pull_number: number }),
    gh.rest.pulls.listFiles({
      owner: rc.owner,
      repo: rc.repo,
      pull_number: number,
      per_page: 100,
    }),
  ]);

  const header =
    `${files.data.length} files changed, +${pr.data.additions}/-${pr.data.deletions}` +
    (pr.data.draft ? " (draft)" : "");
  const fileLines = files.data
    .map((f) => `  ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`)
    .join("\n");

  let patch = "";
  const structured: { path: string; patch: string }[] = [];
  for (const f of files.data) {
    if (!f.patch) continue;
    if (patch.length + f.patch.length > MAX_DIFF) {
      patch += "\n... (diff truncated) ...";
      break;
    }
    patch += `\n--- ${f.filename} ---\n${f.patch}\n`;
    structured.push({ path: f.filename, patch: f.patch });
  }

  return {
    isDraft: pr.data.draft ?? false,
    diffSummary: `${header}\n${fileLines}\n${patch}`.trim(),
    files: structured,
    headRef: pr.data.head.sha,
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n...(truncated)..." : s;
}
