import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TriageItem } from "../types.ts";
import { DecisionSchema, DecisionJsonSchema, type Decision } from "./schema.ts";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.ts";
import { buildGithubReadTools, TOOL_SERVER } from "./tools.ts";
import { preparePrCheckout } from "./checkout.ts";

/** The read environment handed to a judging run: how the model inspects the code. */
interface ReadEnv {
  /** Working dir for built-in Read/Grep/Glob (a PR-head checkout), or undefined for API mode */
  cwd?: string;
  allowedTools: string[];
  mcpServers: Record<string, ReturnType<typeof buildGithubReadTools>["server"]>;
  /** Blurb appended to the user prompt describing which tools are actually available */
  toolsHelp: string;
}

const GET_ISSUE_TOOL = `mcp__${TOOL_SERVER}__get_issue`;

const LOCAL_TOOLS_HELP = `You have a local checkout of this PR's head branch at the current working directory — the real code at the correct ref (a PR's base is not always the default branch). Inspect it with the read-only tools before judging:
- Grep — ripgrep over the whole repo; find a symbol's definition and its callers, unlimited.
- Read — read any file in full (not just the changed lines).
- Glob — find files by path pattern.
- get_issue(number) — read another issue/PR (title/state/body), e.g. a linked or duplicate one.
Trace every change into the real code (callers, types, tests) before forming reviewPoints; never assert from guesswork.`;

const API_TOOLS_HELP = `Use the read-only tools to inspect code beyond the diff:
- get_file(path, ref?) — read a file's FULL content (for a PR defaults to the PR's head version), or list a directory.
- search_code(query) — search the repo's code (default branch) for a symbol/string to find a definition or callers; then get_file the hits.
- get_issue(number) — read another issue/PR (title/state/body), e.g. a linked or duplicate one.
You MUST use get_file when a changed file's diff is "diff NOT shown" or the diff lacks the surrounding context (the function being changed, its callers, the types/tests it touches). Trace the change into the code before forming reviewPoints; never assert from guesswork.`;

interface RunResult {
  /** SDK-parsed structured output (present when the run produced valid json_schema output) */
  structured: unknown;
  /** Best text we captured: the final result string, else the last assistant text */
  text: string;
  /** Terminal result subtype: "success" or an error kind (max_turns, execution, …) */
  subtype: string;
  /** Error strings the SDK attached to a non-success result */
  errors: string[];
}

/**
 * Judge a TriageItem via the Claude Agent SDK, returning a zod-validated Decision.
 * The model may call read-only tools (whole files, callers, linked issues) before
 * answering, then emits its verdict as SDK-enforced structured output (DecisionJsonSchema).
 * We still run DecisionSchema.safeParse to enforce the cross-field rules JSON Schema
 * can't express; on a validation failure we feed the error back and retry once.
 */
export async function judge(item: TriageItem, model: string): Promise<Decision> {
  const env = await buildReadEnv(item);
  const userPrompt = buildUserPrompt(item, env.toolsHelp);
  let lastText = "";
  let lastError = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt =
      attempt === 1
        ? userPrompt
        : `${userPrompt}\n\n[your previous answer failed validation]: ${lastError}\nProduce a corrected judgment that satisfies every rule.`;

    const run = await runQuery(prompt, model, env);
    lastText = run.text;
    if (run.subtype !== "success") {
      // An error result (e.g. max_turns) carries no clean output; surface why so a
      // permanently-failing item is diagnosable instead of silently retried forever.
      console.warn(
        `[judge] ${item.owner}/${item.repo}#${item.number} run ended with "${run.subtype}"` +
          (run.errors.length ? `: ${run.errors.join("; ")}` : ""),
      );
    }

    // Prefer the SDK's schema-validated object; fall back to parsing whatever text
    // we captured (covers max_turns runs that still emitted JSON in their last turn).
    const raw = run.structured ?? extractJson(run.text);
    if (raw === undefined) {
      lastError =
        run.subtype !== "success" ? `run ${run.subtype}` : "no JSON object found";
      continue;
    }
    const parsed = DecisionSchema.safeParse(raw);
    if (parsed.success) {
      // Safety net: if itemType disagrees with reality, trust the actual item
      parsed.data.itemType =
        item.itemType === "pull_request" ? "pull_request" : "issue";
      return parsed.data;
    }
    lastError = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }

  throw new Error(
    `Judge failed: no valid Decision (${lastError}). Raw output:\n${lastText.slice(0, 800)}`,
  );
}

/**
 * Decide how the model inspects the code for this item. For a PR we try a shallow
 * checkout of its head and hand the model read-only built-in tools (Grep/Read/Glob)
 * scoped to that working tree — the correct ref, no rate limits, and NO Bash so it
 * can never execute untrusted PR code. If the checkout fails (or the item is an
 * issue), fall back to the scoped read-only GitHub API tools.
 */
async function buildReadEnv(item: TriageItem): Promise<ReadEnv> {
  const tools = buildGithubReadTools(item.owner, item.repo, item.headRef);
  const mcpServers = { [TOOL_SERVER]: tools.server };

  if (item.itemType === "pull_request" && item.headRef) {
    const cwd = await preparePrCheckout(item);
    if (cwd) {
      return {
        cwd,
        // Read-only built-ins + get_issue (issues aren't on disk). No Bash/Edit/Write.
        allowedTools: ["Read", "Grep", "Glob", GET_ISSUE_TOOL],
        mcpServers,
        toolsHelp: LOCAL_TOOLS_HELP,
      };
    }
  }

  return { allowedTools: tools.allowedTools, mcpServers, toolsHelp: API_TOOLS_HELP };
}

async function runQuery(
  prompt: string,
  model: string,
  env: ReadEnv,
): Promise<RunResult> {
  let structured: unknown;
  let resultText = "";
  let lastAssistantText = "";
  let subtype = "no_result";
  let errors: string[] = [];

  for await (const msg of query({
    prompt,
    options: {
      model,
      systemPrompt: SYSTEM_PROMPT,
      ...(env.cwd ? { cwd: env.cwd } : {}),
      mcpServers: env.mcpServers,
      allowedTools: env.allowedTools,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Force the verdict into our schema so we don't hand-parse free text.
      outputFormat: { type: "json_schema", schema: DecisionJsonSchema },
      maxTurns: 30, // allow many tool calls so it can read the code before answering
    },
  })) {
    if (msg.type === "assistant") {
      // Keep the latest assistant text as a fallback if no clean result arrives
      // (e.g. the run hits max_turns after the model already wrote its answer).
      const t = assistantText(msg);
      if (t) lastAssistantText = t;
    } else if (msg.type === "result") {
      subtype = msg.subtype;
      if (msg.subtype === "success") {
        resultText = msg.result;
        structured = msg.structured_output;
      } else {
        errors = (msg as { errors?: string[] }).errors ?? [];
      }
    }
  }

  return {
    structured,
    text: resultText || lastAssistantText,
    subtype,
    errors,
  };
}

/** Concatenate the text blocks of an SDK assistant message. */
function assistantText(msg: {
  message?: { content?: unknown };
}): string {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        !!b && typeof b === "object" && (b as { type?: string }).type === "text",
    )
    .map((b) => b.text)
    .join("");
}

/** Extract a JSON object from model output: strip code fences, take first { to matching } */
export function extractJson(text: string): unknown {
  if (!text) return undefined;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const start = s.indexOf("{");
  if (start === -1) return undefined;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
