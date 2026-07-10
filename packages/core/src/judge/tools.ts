import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getOctokit } from "../github/client.ts";

export const TOOL_SERVER = "github_ro";
export const TOOL_NAMES = [
  `mcp__${TOOL_SERVER}__get_file`,
  `mcp__${TOOL_SERVER}__get_issue`,
  `mcp__${TOOL_SERVER}__search_code`,
];

const MAX_FILE = 30000;

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n…(truncated)" : s;
}

/**
 * Read-only GitHub tools scoped to one repo, for the judge to inspect code beyond
 * the diff on demand. owner/repo/defaultRef are baked in — the model only supplies
 * path/ref/number. defaultRef is the PR head sha for PRs (else the default branch).
 */
export function buildGithubReadTools(
  owner: string,
  repo: string,
  defaultRef?: string,
) {
  const getFile = tool(
    "get_file",
    "Read a file's full content from the repo (or list a directory). For a PR this defaults to the PR's head version. Use it to see code the diff doesn't show — the whole changed file, a caller, a referenced module.",
    { path: z.string(), ref: z.string().optional() },
    async ({ path, ref }) => {
      console.log(`[judge] get_file ${owner}/${repo} ${path}${ref ? `@${ref}` : ""}`);
      try {
        const { data } = await getOctokit().rest.repos.getContent({
          owner,
          repo,
          path,
          ref: ref || defaultRef,
        });
        if (Array.isArray(data)) {
          return text(`Directory ${path}:\n${data.map((e) => `${e.type}\t${e.path}`).join("\n")}`);
        }
        if (data.type === "file" && "content" in data && data.content) {
          const body = Buffer.from(data.content, "base64").toString("utf8");
          return text(`File ${path} @ ${ref || defaultRef || "default"}:\n${clip(body, MAX_FILE)}`);
        }
        return text(`(${path}: no readable file content)`);
      } catch (e) {
        return text(`ERROR reading ${path}: ${(e as Error).message}`);
      }
    },
  );

  const getIssue = tool(
    "get_issue",
    "Read another issue or PR in this repo by number (title, state, body). Use it to check a linked/duplicate issue (e.g. 'Fixes #123').",
    { number: z.number().int().positive() },
    async ({ number }) => {
      console.log(`[judge] get_issue ${owner}/${repo} #${number}`);
      try {
        const { data } = await getOctokit().rest.issues.get({
          owner,
          repo,
          issue_number: number,
        });
        return text(
          `#${data.number} [${data.state}] ${data.title}\n\n${clip(data.body ?? "", 4000)}`,
        );
      } catch (e) {
        return text(`ERROR reading #${number}: ${(e as Error).message}`);
      }
    },
  );

  const searchCode = tool(
    "search_code",
    "Search this repo's code for a string or symbol (e.g. a function/class name) to find its definition and callers before judging a change. Searches the default branch's indexed code. Returns matching file paths with snippets — follow up with get_file to read full context.",
    { query: z.string() },
    async ({ query: q }) => {
      console.log(`[judge] search_code ${owner}/${repo} ${q}`);
      try {
        const { data } = await getOctokit().rest.search.code({
          q: `${q} repo:${owner}/${repo}`,
          per_page: 15,
          headers: { accept: "application/vnd.github.text-match+json" },
        });
        if (!data.items.length) {
          return text(`No code matches for "${q}" in ${owner}/${repo} (default branch).`);
        }
        const out = data.items
          .map((it) => {
            const frags = ((it as { text_matches?: { fragment?: string }[] }).text_matches ?? [])
              .map((m) => m.fragment?.trim())
              .filter(Boolean)
              .slice(0, 2)
              .join("\n  …\n");
            return `• ${it.path}${frags ? `\n${clip(frags, 500)}` : ""}`;
          })
          .join("\n\n");
        return text(
          `Code matches for "${q}" (${data.total_count} total, showing ${data.items.length}):\n\n${out}`,
        );
      } catch (e) {
        return text(`ERROR searching "${q}": ${(e as Error).message}`);
      }
    },
  );

  const server = createSdkMcpServer({
    name: TOOL_SERVER,
    version: "1.0.0",
    tools: [getFile, getIssue, searchCode],
  });

  return { server, allowedTools: TOOL_NAMES };
}
