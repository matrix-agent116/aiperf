import { Octokit } from "@octokit/rest";
import { requireEnv } from "../config.ts";

let client: Octokit | null = null;

export function getOctokit(): Octokit {
  if (!client) {
    client = new Octokit({
      auth: requireEnv("GITHUB_TOKEN"),
      userAgent: "gh-triage-agent",
    });
  }
  return client;
}

let selfLogin: string | null = null;

/**
 * The login of the authenticated GITHUB_TOKEN user (the maintainer whose replies/actions
 * this agent posts). Cached for the process. Returns null if it can't be resolved, so
 * callers treat "unknown self" as "don't skip" rather than crashing.
 */
export async function getSelfLogin(): Promise<string | null> {
  if (selfLogin === null) {
    try {
      const { data } = await getOctokit().rest.users.getAuthenticated();
      selfLogin = data.login;
    } catch (e) {
      console.warn(`[github] could not resolve authenticated user: ${(e as Error).message}`);
      return null;
    }
  }
  return selfLogin;
}
