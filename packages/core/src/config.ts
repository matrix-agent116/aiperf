import { z } from "zod";

const RepoConfigSchema = z.object({
  url: z.string().url(),
  watch: z
    .array(z.enum(["issues", "pulls"]))
    .nonempty()
    .default(["issues", "pulls"]),
  only_from_others: z.boolean().default(true),
  ignore_authors: z.array(z.string()).default([]),
});

/**
 * All user configuration, edited on the in-app settings page and persisted in the
 * sqlite `settings` table (no config files, no env vars).
 */
export const SettingsSchema = z.object({
  /** PAT / App token with write access to the watched repos */
  github_token: z.string().min(1, "GitHub token 不能为空"),
  /**
   * Claude auth override. Empty = use the machine's Claude Code login (Keychain).
   * "sk-ant-oat…" (and any non-sk-ant value) is a Claude Code OAuth token;
   * other "sk-ant-…" values are API keys.
   */
  claude_token: z.string().default(""),
  poll_interval_minutes: z.number().positive().default(5),
  model: z.string().default("claude-opus-4-8"),
  /** App interface language (server-rendered pages) */
  ui_language: z.enum(["zh", "en"]).default("zh"),
  /**
   * Language of judge output written FOR THE HUMAN (reasoning, draft previews).
   * Free-form language name fed to the judge prompt, e.g. "中文", "English", "日本語".
   */
  display_language: z.string().min(1).default("中文"),
  /** Language of text actually POSTED to GitHub (replies, review comments). */
  post_language: z.string().min(1).default("English"),
  // Empty is allowed: the setup wizard configures tokens/model only, and repos are
  // added later from the Inbox page (a cycle over zero repos is just a no-op).
  repos: z.array(RepoConfigSchema).default([]),
});

export type Settings = z.infer<typeof SettingsSchema>;

export type RepoConfig = z.infer<typeof RepoConfigSchema> & {
  owner: string;
  repo: string;
};
export type AppConfig = Omit<Settings, "repos"> & {
  repos: RepoConfig[];
};

/** github.com/owner/repo -> { owner, repo } */
function parseRepoUrl(url: string): { owner: string; repo: string } {
  const m = url.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (!m) throw new Error(`Cannot parse owner/repo from URL: ${url}`);
  return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
}

export type ParseResult =
  | { ok: true; settings: Settings; config: AppConfig }
  | { ok: false; error: string };

/** Validate raw (page-submitted or stored) settings and derive the runtime config. */
export function parseSettings(raw: unknown): ParseResult {
  const parsed = SettingsSchema.safeParse(raw);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error };
  }
  let repos: RepoConfig[];
  try {
    repos = parsed.data.repos.map((r) => ({ ...r, ...parseRepoUrl(r.url) }));
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return {
    ok: true,
    settings: parsed.data,
    config: { ...parsed.data, repos },
  };
}
