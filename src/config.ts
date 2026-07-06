import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
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

const AppConfigSchema = z.object({
  poll_interval_minutes: z.number().positive().default(5),
  model: z.string().default("claude-opus-4-8"),
  lookback_days_on_first_run: z.number().positive().default(7),
  reminder_after_hours: z.number().nonnegative().default(24), // 0 disables reminders
  telegram: z.object({
    chat_id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  }),
  // Built-in HTTP service that serves the draft-reply preview pages.
  http: z
    .object({
      port: z.number().int().positive().default(8787),
      base_url: z.string().url().optional(), // externally reachable; defaults to http://localhost:<port>
    })
    .default({}),
  repos: z.array(RepoConfigSchema).nonempty(),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema> & {
  owner: string;
  repo: string;
};
export type AppConfig = Omit<z.infer<typeof AppConfigSchema>, "repos"> & {
  repos: RepoConfig[];
};

/** github.com/owner/repo -> { owner, repo } */
function parseRepoUrl(url: string): { owner: string; repo: string } {
  const m = url.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (!m) throw new Error(`Cannot parse owner/repo from URL: ${url}`);
  return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
}

export function loadConfig(path = process.env.CONFIG_PATH ?? "./config.yaml"): AppConfig {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read config file (${path}): ${(err as Error).message}`);
  }

  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Config validation failed:\n${details}`);
  }

  const repos: RepoConfig[] = parsed.data.repos.map((r) => ({
    ...r,
    ...parseRepoUrl(r.url),
  }));

  return { ...parsed.data, repos };
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}; set it in .env`);
  return v;
}
