import { z } from "zod";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { extractJson } from "./judge.ts";
import { prepareRepoCheckout } from "./checkout.ts";

/**
 * Whole-repo analysis (architecture map + security scan), rendered on the /repo
 * page. Like judging, the model only ever gets read-only tools on a local
 * checkout — NEVER Bash/Edit/Write, it must not execute the repo's code.
 * Every user-facing field is a zh/en pair (display language is a setting).
 */

const ComponentSchema = z.object({
  /** Short identifier shown in the box, e.g. "poller" or "web UI" */
  name: z.string(),
  /** Main path(s), e.g. "src/github/poller.ts" */
  path: z.string(),
  /** Architectural layer this belongs to, English label e.g. "Entry", "Core", "Storage" */
  group: z.string(),
  groupZh: z.string().optional(),
  /** One-line role, English */
  role: z.string(),
  roleZh: z.string().optional(),
  /** Names of other components this one calls/depends on */
  dependsOn: z.array(z.string()).default([]),
});
export type RepoComponent = z.infer<typeof ComponentSchema>;

export const FindingSeverityEnum = z.enum(["critical", "high", "medium", "low"]);
export type FindingSeverity = z.infer<typeof FindingSeverityEnum>;

const FindingSchema = z.object({
  severity: FindingSeverityEnum,
  /** English title */
  title: z.string(),
  titleZh: z.string().optional(),
  /** What/where/why it is exploitable, English */
  detail: z.string(),
  detailZh: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().positive().nullable().optional(),
  /** How to fix, English */
  suggestion: z.string().optional(),
  suggestionZh: z.string().optional(),
});
export type RepoFinding = z.infer<typeof FindingSchema>;

export const RepoAnalysisSchema = z
  .object({
    /** 2-4 sentence architecture overview, English */
    overview: z.string(),
    overviewZh: z.string().optional(),
    components: z.array(ComponentSchema).min(1).max(16),
    findings: z.array(FindingSchema).max(20).default([]),
  })
  .superRefine((a, ctx) => {
    if (!a.overviewZh?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["overviewZh"],
        message: "overviewZh (中文 version) is required",
      });
    }
    a.components.forEach((c, i) => {
      if (!c.roleZh?.trim() || !c.groupZh?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["components", i],
          message: "roleZh and groupZh (中文 versions) are required for every component",
        });
      }
    });
    a.findings.forEach((f, i) => {
      if (!f.titleZh?.trim() || !f.detailZh?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["findings", i],
          message: "titleZh and detailZh (中文 versions) are required for every finding",
        });
      }
    });
  });
export type RepoAnalysis = z.infer<typeof RepoAnalysisSchema>;

/** What actually gets stored/rendered: the analysis plus the analyzed commit. */
export type RepoAnalysisResult = RepoAnalysis & {
  commitSha: string;
  commitTimeMs: number;
};

/** JSON Schema mirror of RepoAnalysisSchema for the SDK's outputFormat — keep in sync. */
const RepoAnalysisJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["overview", "overviewZh", "components", "findings"],
  properties: {
    overview: { type: "string" },
    overviewZh: { type: "string" },
    components: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "path", "group", "groupZh", "role", "roleZh", "dependsOn"],
        properties: {
          name: { type: "string" },
          path: { type: "string" },
          group: { type: "string" },
          groupZh: { type: "string" },
          role: { type: "string" },
          roleZh: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
        },
      },
    },
    findings: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "titleZh", "detail", "detailZh"],
        properties: {
          severity: { type: "string", enum: FindingSeverityEnum.options },
          title: { type: "string" },
          titleZh: { type: "string" },
          detail: { type: "string" },
          detailZh: { type: "string" },
          file: { type: "string" },
          line: { type: ["integer", "null"] },
          suggestion: { type: "string" },
          suggestionZh: { type: "string" },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are a senior software architect and application-security auditor. You inspect a repository through read-only tools (Read, Grep, Glob) on a local checkout and produce a faithful architecture map and a security review. You never guess: every component and every finding must be grounded in files you actually read. You never execute code.`;

const USER_PROMPT = `Analyze the repository at the current working directory.

Work in two phases:

1. ARCHITECTURE — Explore the layout (manifests, entrypoints, directory structure), then read the key modules. Identify up to 16 real components (module/subsystem granularity, not every file) and organize them into 3-6 layers via the "group" field (e.g. Entry / UI / Core / Integrations / Storage). For each component record its main path, a one-line role, and which other components it depends on (use the exact "name" values).

2. SECURITY — Audit what you read for real vulnerabilities and risky patterns: injection (SQL/command/path), missing auth checks, secrets in code, unsafe deserialization, SSRF, XSS in rendered HTML, permissive CORS, dependency red flags, dangerous child-process/eval use, world-readable tokens, etc. Report only findings you can point to (file + line where possible), each with severity:
- critical: remotely exploitable / credential leak
- high: exploitable with conditions
- medium: weakness that needs a second factor to exploit
- low: hardening gap / bad practice
An empty findings list is a valid answer for a clean codebase — do not invent findings.

Every prose field must be provided in BOTH English (title/detail/role/…) and 中文 (…Zh variants), same meaning.`;

/** Run the whole-repo analysis. Throws with a readable message on failure. */
export async function analyzeRepo(
  owner: string,
  repo: string,
  model: string,
): Promise<RepoAnalysisResult> {
  const checkout = await prepareRepoCheckout(owner, repo);
  if (!checkout) {
    throw new Error("无法检出仓库代码（git 不可用或无访问权限）");
  }
  const cwd = checkout.dir;

  let lastError = "";
  let lastText = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt =
      attempt === 1
        ? USER_PROMPT
        : `${USER_PROMPT}\n\n[your previous answer failed validation]: ${lastError}\nProduce a corrected analysis that satisfies every rule.`;

    let structured: unknown;
    let resultText = "";
    let subtype = "no_result";
    for await (const msg of query({
      prompt,
      options: {
        model,
        systemPrompt: SYSTEM_PROMPT,
        // See judge.ts: literal "node" is missing from a Finder-launched app's PATH.
        executable: process.execPath as "node",
        cwd,
        // Read-only built-ins only — the repo's code is untrusted, never executed.
        allowedTools: ["Read", "Grep", "Glob"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        outputFormat: { type: "json_schema", schema: RepoAnalysisJsonSchema },
        maxTurns: 60, // whole-repo exploration takes many reads
      },
    })) {
      if (msg.type === "result") {
        subtype = msg.subtype;
        if (msg.subtype === "success") {
          resultText = msg.result;
          structured = msg.structured_output;
        }
      }
    }
    lastText = resultText;

    const raw = structured ?? extractJson(resultText);
    if (raw === undefined) {
      lastError = subtype !== "success" ? `run ${subtype}` : "no JSON object found";
      continue;
    }
    const parsed = RepoAnalysisSchema.safeParse(raw);
    if (parsed.success) {
      return { ...parsed.data, commitSha: checkout.sha, commitTimeMs: checkout.commitTimeMs };
    }
    lastError = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }

  throw new Error(
    `Repo analysis failed: ${lastError}. Raw output:\n${lastText.slice(0, 500)}`,
  );
}
