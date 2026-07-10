/** One item assembled by the poller and handed to the judge */
export interface TriageItem {
  owner: string;
  repo: string;
  itemType: "issue" | "pull_request";
  number: number;
  title: string;
  body: string;
  author: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  state: string;
  labels: string[];
  comments: { author: string; body: string; createdAt: string }[];
  /** PR only: change summary (file count / added-removed lines / truncated diff) */
  diffSummary?: string;
  /** PR only: per-file patches shown inline (fit the budget), used to anchor review points */
  files?: { path: string; patch: string }[];
  /** PR only: the complete changed-file list; `shown` = its diff is inline below */
  changedFiles?: {
    path: string;
    status: string;
    additions: number;
    deletions: number;
    shown: boolean;
  }[];
  /** PR only: head commit sha, used as the default ref for read tools */
  headRef?: string;
  /** PR only */
  isDraft?: boolean;
}

/** Persisted PR context needed to render the review page without re-hitting GitHub */
export interface PrContext {
  files: { path: string; patch: string }[];
}

/** Stable identifier for an item (used for cursor dedupe) */
export function itemKey(i: Pick<TriageItem, "owner" | "repo" | "itemType" | "number">): string {
  return `${i.owner}/${i.repo}#${i.itemType}-${i.number}`;
}
