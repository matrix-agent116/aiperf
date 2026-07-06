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
