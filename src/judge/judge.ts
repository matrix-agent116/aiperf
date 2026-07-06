import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TriageItem } from "../types.ts";
import { DecisionSchema, type Decision } from "./schema.ts";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.ts";

/**
 * Judge a TriageItem via the Claude Agent SDK, returning a zod-validated Decision.
 * Judging is plain-text reasoning (no tools): the poller already assembled full context.
 * On a parse failure, feed the validation error back to the model and retry once.
 */
export async function judge(item: TriageItem, model: string): Promise<Decision> {
  const userPrompt = buildUserPrompt(item);
  let lastText = "";
  let lastError = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt =
      attempt === 1
        ? userPrompt
        : `${userPrompt}\n\n[previous output could not be parsed]: ${lastError}\nOutput exactly one valid JSON object, with no extra text and no code fences.`;

    lastText = await runQuery(prompt, model);
    const json = extractJson(lastText);
    if (json === undefined) {
      lastError = "no JSON object found";
      continue;
    }
    const parsed = DecisionSchema.safeParse(json);
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

async function runQuery(prompt: string, model: string): Promise<string> {
  let result = "";
  for await (const msg of query({
    prompt,
    options: {
      model,
      systemPrompt: SYSTEM_PROMPT,
      allowedTools: [],
      permissionMode: "bypassPermissions",
      maxTurns: 1,
    },
  })) {
    if (msg.type === "result" && msg.subtype === "success") {
      result = msg.result;
    }
  }
  return result;
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
