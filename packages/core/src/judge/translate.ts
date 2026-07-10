import { query } from "@anthropic-ai/claude-agent-sdk";
import { extractJson } from "./judge.ts";
import type { Store } from "../store.ts";

/**
 * One-shot translation of an archived item's conversation (opening body + every
 * timeline entry) into the display language, cached on the archive row — the
 * 原始/译文 toggle on pending cards swaps stored variants, never re-translates.
 * A re-sync of the item resets the cache (content changed), and the engine's
 * sweep re-translates items that still have an open card.
 */

const MAX_TEXT = 3000; // per-text clip fed to the translator

const SYSTEM_PROMPT = `You are a precise technical translator for GitHub issue/PR conversations. Preserve markdown structure exactly. Never translate code blocks, inline code, URLs, file paths, version numbers, @usernames or #issue references. An empty string stays an empty string.`;

export async function translateItemHistory(
  store: Store,
  owner: string,
  repo: string,
  itemType: "issue" | "pull_request",
  number: number,
  targetLang: string,
  model: string,
): Promise<void> {
  const repoKey = `${owner}/${repo}`;
  const it = store.getArchiveItem(repoKey, itemType, number);
  if (!it) return; // not archived yet — the next sweep will catch it
  if (it.trLang === targetLang) return; // cached and current

  const texts = [clip(it.body), ...it.timeline.map((e) => clip(e.body))];
  if (texts.every((s) => !s.trim())) {
    store.setArchiveTranslation(repoKey, itemType, number, targetLang, "", it.timeline);
    return;
  }

  const schema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    required: ["translations"],
    properties: {
      translations: {
        type: "array",
        items: { type: "string" },
        minItems: texts.length,
        maxItems: texts.length,
      },
    },
  };
  const prompt = `Translate every element of this JSON array into ${targetLang} (same order, same length, ${texts.length} elements):\n\n${JSON.stringify(texts)}`;

  let structured: unknown;
  let resultText = "";
  let lastAssistant = "";
  let subtype = "no_result";
  for await (const msg of query({
    prompt,
    options: {
      model,
      systemPrompt: SYSTEM_PROMPT,
      executable: process.execPath as "node",
      allowedTools: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      outputFormat: { type: "json_schema", schema },
      // The structured-output handshake needs a few turns even with no tools.
      maxTurns: 8,
    },
  })) {
    if (msg.type === "assistant") {
      const content = (msg as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(content)) {
        const text = content
          .filter((b): b is { type: "text"; text: string } =>
            !!b && typeof b === "object" && (b as { type?: string }).type === "text")
          .map((b) => b.text)
          .join("");
        if (text) lastAssistant = text;
      }
    } else if (msg.type === "result") {
      subtype = msg.subtype;
      if (msg.subtype === "success") {
        resultText = msg.result;
        structured = msg.structured_output;
      }
    }
  }

  const raw = (structured ?? extractJson(resultText || lastAssistant)) as
    | { translations?: unknown }
    | undefined;
  const tr = raw?.translations;
  if (!Array.isArray(tr) || tr.length !== texts.length || !tr.every((s) => typeof s === "string")) {
    throw new Error(`translator returned ${Array.isArray(tr) ? tr.length : "no"} translations for ${texts.length} texts (run ${subtype})`);
  }

  const timeline = it.timeline.map((e, i) => ({ ...e, bodyTr: tr[i + 1] }));
  store.setArchiveTranslation(repoKey, itemType, number, targetLang, tr[0], timeline);
  console.log(`[translate] ${repoKey}#${number} → ${targetLang} (${texts.length} texts)`);
}

function clip(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "\n...(truncated)..." : s;
}
