import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getGithubToken } from "../github/client.ts";
import type { TriageItem } from "../types.ts";

const pexec = promisify(execFile);

/** Where per-repo clones live; sits next to the sqlite state in ./data by default. */
const REPOS_DIR = process.env.REPOS_DIR ?? "./data/repos";
const GIT_TIMEOUT = 90_000; // fetch of a single shallow commit shouldn't take longer

/**
 * A shallow (depth-1) checkout of a PR's head, so the judge can Read/Grep the real
 * code at the *correct ref* — the PR's own branch, whose base is not necessarily the
 * repo's default branch (which is all GitHub code search would index). We only need
 * head: it already contains the base code plus the PR's changes; the base diff is
 * supplied separately in the prompt. Returns the working-tree dir, or null if git
 * isn't usable (missing binary, network, private repo without access) so the caller
 * can fall back to the API-based read tools.
 */
export async function preparePrCheckout(item: TriageItem): Promise<string | null> {
  const dir = resolve(join(REPOS_DIR, `${item.owner}__${item.repo}`));
  const ref = `refs/pull/${item.number}/head`;
  try {
    await mkdir(dir, { recursive: true });
    if (!(await exists(join(dir, ".git")))) {
      await git(dir, ["init", "-q"]);
    }
    // Fetch the PR head as a single detached commit via an inline authenticated URL
    // (keeps the token out of the persisted .git/config remote). --no-tags trims noise.
    await git(dir, [
      "fetch",
      "--depth",
      "1",
      "--no-tags",
      "-q",
      authUrl(item.owner, item.repo),
      ref,
    ]);
    // Replace the working tree with the fetched head; drop anything left from a prior PR.
    await git(dir, ["reset", "--hard", "-q", "FETCH_HEAD"]);
    await git(dir, ["clean", "-qdff"]);
    console.log(
      `[judge] checkout ${item.owner}/${item.repo}#${item.number} @ ${item.headRef?.slice(0, 8) ?? ref} -> ${dir}`,
    );
    return dir;
  } catch (e) {
    console.warn(
      `[judge] checkout failed for ${item.owner}/${item.repo}#${item.number}, falling back to API tools: ${(e as Error).message}`,
    );
    return null;
  }
}

export interface RepoCheckout {
  dir: string;
  /** Full SHA of the checked-out default-branch head */
  sha: string;
  /** Commit (committer) time of that head, ms since epoch */
  commitTimeMs: number;
}

/**
 * A shallow checkout of the repo's DEFAULT branch (whatever HEAD points at) for
 * whole-repo analysis. Lives in its own directory so it never races a concurrent
 * PR-head checkout of the same repo (those reset the working tree per PR).
 * Always re-fetches, so the analysis runs against the repo's current head.
 */
export async function prepareRepoCheckout(
  owner: string,
  repo: string,
): Promise<RepoCheckout | null> {
  const dir = resolve(join(REPOS_DIR, `${owner}__${repo}__default`));
  try {
    await mkdir(dir, { recursive: true });
    if (!(await exists(join(dir, ".git")))) {
      await git(dir, ["init", "-q"]);
    }
    await git(dir, [
      "fetch",
      "--depth",
      "1",
      "--no-tags",
      "-q",
      authUrl(owner, repo),
      "HEAD",
    ]);
    await git(dir, ["reset", "--hard", "-q", "FETCH_HEAD"]);
    await git(dir, ["clean", "-qdff"]);
    const head = (await gitOut(dir, ["log", "-1", "--format=%H|%ct"])).trim();
    const [sha, ct] = head.split("|");
    console.log(`[analysis] checkout ${owner}/${repo}@${sha.slice(0, 8)} -> ${dir}`);
    return { dir, sha, commitTimeMs: Number(ct) * 1000 };
  } catch (e) {
    console.warn(
      `[analysis] checkout failed for ${owner}/${repo}: ${(e as Error).message}`,
    );
    return null;
  }
}

function authUrl(owner: string, repo: string): string {
  return `https://x-access-token:${getGithubToken()}@github.com/${owner}/${repo}.git`;
}

async function git(dir: string, args: string[]): Promise<void> {
  await pexec("git", ["-C", dir, ...args], {
    timeout: GIT_TIMEOUT,
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function gitOut(dir: string, args: string[]): Promise<string> {
  const { stdout } = await pexec("git", ["-C", dir, ...args], {
    timeout: GIT_TIMEOUT,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
