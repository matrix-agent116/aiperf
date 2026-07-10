import { Octokit } from "@octokit/rest";

let client: Octokit | null = null;
let token: string | null = null;
let selfLogin: string | null = null;

/**
 * Install the GitHub token from the app settings. Called on startup and whenever
 * the settings are saved; a token change resets the cached client and self login.
 */
export function configureGithub(newToken: string): void {
  if (newToken === token) return;
  token = newToken;
  client = null;
  selfLogin = null;
}

export function getGithubToken(): string {
  if (!token) throw new Error("GitHub token 未配置（请在设置页填写）");
  return token;
}

export function getOctokit(): Octokit {
  if (!client) {
    client = new Octokit({
      auth: getGithubToken(),
      userAgent: "gh-triage-agent",
    });
  }
  return client;
}

/**
 * The login of the authenticated token user (the maintainer whose replies/actions
 * this agent posts). Cached until the token changes. Returns null if it can't be
 * resolved, so callers treat "unknown self" as "don't skip" rather than crashing.
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
