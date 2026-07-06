import { InlineKeyboard } from "grammy";
import type { PendingDecision } from "../store.ts";
import type { SuggestedAction } from "../judge/schema.ts";

const ACTION_LABEL: Record<SuggestedAction, string> = {
  none: "无动作",
  close_issue: "关闭 issue",
  approve_pr: "批准 PR",
  request_changes_pr: "要求修改 PR",
  close_pr: "关闭 PR",
  add_labels: "打标签",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Clip long text to stay under Telegram's 4096-byte limit */
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n…(截断)" : s;
}

export function renderMessage(
  p: PendingDecision,
  baseUrl: string,
): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const d = p.decision;
  const typeLabel = p.itemType === "pull_request" ? "PR" : "Issue";
  const conf = `${Math.round(d.confidence * 100)}%`;

  const lines: string[] = [];
  lines.push(
    `📥 <b>${esc(p.owner)}/${esc(p.repo)}</b> · ${typeLabel} <b>#${p.number}</b>`,
  );
  lines.push(`<b>${esc(clip(p.title, 300))}</b>`);
  lines.push(`🔗 <a href="${esc(p.htmlUrl)}">在 GitHub 打开</a>`);
  lines.push("");
  lines.push(`🧠 <b>判断</b> (置信度 ${conf}):`);
  lines.push(esc(clip(d.reasoning, 1200)));

  const keyboard = new InlineKeyboard();

  if (d.needsReply && p.itemType === "pull_request") {
    // PR: rich per-point review happens on the web page; submission is done there.
    lines.push("");
    lines.push(
      `🔎 <b>PR 审查意见</b> ${d.reviewPoints.length} 条 —— 点按钮逐条审核并提交`,
    );
    const url = `${baseUrl}/review/${p.id}?t=${encodeURIComponent(p.token)}`;
    keyboard.url("🔎 逐条审核并提交", url).row().text("🚫 忽略", `ignore:${p.id}`);
  } else if (d.needsReply) {
    lines.push("");
    lines.push(
      `💬 <b>草稿回复</b>：<a href="${esc(baseUrl)}/reply/${p.id}">点此查看</a>`,
    );
    keyboard
      .text("✅ 批准并回复", `reply:${p.id}`)
      .text("✏️ 修改", `edit:${p.id}`)
      .row()
      .text("🚫 忽略", `ignore:${p.id}`);
  } else {
    lines.push("");
    lines.push(`🛠 <b>建议动作</b>: ${esc(ACTION_LABEL[d.suggestedAction])}`);
    if (d.suggestedAction === "add_labels" && d.labels.length) {
      lines.push(`🏷 标签: ${esc(d.labels.join(", "))}`);
    }
    if (d.suggestedAction === "none") {
      keyboard.text("🚫 忽略", `ignore:${p.id}`);
    } else {
      keyboard
        .text(`✅ 执行「${ACTION_LABEL[d.suggestedAction]}」`, `act:${p.id}`)
        .row()
        .text("🚫 忽略", `ignore:${p.id}`);
    }
  }

  return { text: clip(lines.join("\n"), 4000), keyboard };
}
