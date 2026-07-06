import type { PendingDecision } from "../store.ts";
import { getOctokit } from "./client.ts";

interface Ref {
  owner: string;
  repo: string;
  number: number;
}

export async function postComment(ref: Ref, body: string): Promise<void> {
  await getOctokit().rest.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.number,
    body,
  });
}

/**
 * Post a reply to an issue or PR, returning the html_url of what was created.
 *  - issue → a normal comment
 *  - PR    → a PR Review with event=COMMENT (not approve/reject)
 */
export async function postReply(
  p: Pick<PendingDecision, "owner" | "repo" | "number" | "itemType">,
  body: string,
): Promise<string> {
  const gh = getOctokit();
  if (p.itemType === "pull_request") {
    const { data } = await gh.rest.pulls.createReview({
      owner: p.owner,
      repo: p.repo,
      pull_number: p.number,
      event: "COMMENT",
      body,
    });
    return data.html_url;
  }
  const { data } = await gh.rest.issues.createComment({
    owner: p.owner,
    repo: p.repo,
    issue_number: p.number,
    body,
  });
  return data.html_url;
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

/** Submit a PR review (event=COMMENT) with a top-level body + inline line comments. */
export async function submitPrReview(
  p: Pick<PendingDecision, "owner" | "repo" | "number">,
  body: string,
  comments: InlineComment[],
): Promise<string> {
  const { data } = await getOctokit().rest.pulls.createReview({
    owner: p.owner,
    repo: p.repo,
    pull_number: p.number,
    event: "COMMENT",
    body: body || undefined,
    comments: comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: "RIGHT",
      body: c.body,
    })),
  });
  return data.html_url;
}

export async function closeIssue(ref: Ref): Promise<void> {
  await getOctokit().rest.issues.update({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.number,
    state: "closed",
  });
}

export async function approvePr(ref: Ref, body?: string): Promise<void> {
  await getOctokit().rest.pulls.createReview({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
    event: "APPROVE",
    body,
  });
}

export async function requestChangesPr(ref: Ref, body: string): Promise<void> {
  await getOctokit().rest.pulls.createReview({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
    event: "REQUEST_CHANGES",
    body: body || "需要修改。",
  });
}

export async function closePr(ref: Ref): Promise<void> {
  await getOctokit().rest.pulls.update({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
    state: "closed",
  });
}

export async function addLabels(ref: Ref, labels: string[]): Promise<void> {
  await getOctokit().rest.issues.addLabels({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.number,
    labels,
  });
}

/** Execute the write op for the pending item's suggestedAction; return a human-readable receipt */
export async function executeSuggestedAction(p: PendingDecision): Promise<string> {
  const ref: Ref = { owner: p.owner, repo: p.repo, number: p.number };
  const { suggestedAction, reasoning, labels } = p.decision;

  switch (suggestedAction) {
    case "close_issue":
      await closeIssue(ref);
      return "✅ 已关闭 issue";
    case "approve_pr":
      await approvePr(ref, p.draftReply ?? undefined);
      return "✅ 已批准 PR";
    case "request_changes_pr":
      await requestChangesPr(ref, p.draftReply ?? reasoning);
      return "✅ 已对 PR 提交 request changes";
    case "close_pr":
      await closePr(ref);
      return "✅ 已关闭 PR";
    case "add_labels":
      await addLabels(ref, labels);
      return `✅ 已打标签: ${labels.join(", ")}`;
    case "none":
    default:
      return "ℹ️ 无动作可执行";
  }
}
