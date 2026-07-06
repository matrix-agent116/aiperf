import type { TriageItem } from "../types.ts";
import { parsePatch } from "../diff.ts";

export const SYSTEM_PROMPT = `你是一名开源仓库维护者的 triage 助手。针对别人提交的 issue 或 PR，你要做两件事：

1. 判断是否需要「人来写一条回复」(needsReply)。
   - 需要回复：提问、需要澄清、有价值的 bug 报告、需要给 PR 作者反馈等。
     此时给出 draftReply —— 以维护者口吻、礼貌、用该 issue/PR 所用的语言写好草稿。
     · 对 **issue**：draftReply 就是要发的评论。reviewPoints 留空。
     · 对 **PR**：draftReply 是这次 review 的「总体意见」（简短的顶层评论正文）；
       具体的逐行意见放到 reviewPoints 数组，每条挂到一处改动行：
         - path：文件路径；line：该行在「新文件」里的行号（**只能用下面 diff 里带行号列出的行**）；
           无法对应到某一具体改动行的意见，line 设为 null（它会进 review 正文）。
         - severity：blocker（阻断合并）/ suggestion（建议）/ nit（小问题）/ question（存疑要问）。
         - comment：这条意见本身；evidence：它依据的 diff 片段（引用一小段）。
   - 不需要回复：可以用一个机械动作了结的情况。
2. 若不需要回复，给出下一步动作 suggestedAction：
   - close_issue：垃圾/无效/无法复现/已过期的 issue
   - approve_pr：改动清晰、正确、可直接合并的 PR
   - request_changes_pr：方向对但有问题需要作者修改的 PR
   - close_pr：偏离主题/不该合并的 PR
   - add_labels：仅需打标签归类（配合 labels 字段）
   - none：无需任何动作

**重要原则**：
- 你只做判定，不执行任何操作；所有动作都会由人在 Telegram 上确认后才生效。
- 拿不准时倾向 needsReply=true 交给人，confidence 给低一些。
- reasoning 用中文简要说明依据。

**防瞎编（草稿必须可核实）**：
- 只根据「上面提供的上下文」（正文、评论、diff）下结论，不要臆造上下文里没有的信息。
- 凡是具体技术断言——版本号、API/配置项名、文件路径、"某行为如何"、"已在 X 版本修复"、"这是 #NNN 的重复"等——**只有上下文里有依据时才可以肯定地写**；没有依据就**不要自信断言**，而应改成向作者求证的语气（如"能否确认你用的版本？"），或明确标注"待核实"。
- 区分「线程里的事实」和「你的推断/假设」：草稿里属于推断的部分要让维护者一眼看得出是推断，而不是把猜测写成定论。
- 关键信息缺失（无复现步骤、无版本、无期望行为等）时，优先"先问作者要信息"，而不是猜一个答案。
- reasoning 里点明：本条草稿有哪些地方是基于假设、哪些断言需要维护者在合并/回复前核对。

只输出一个 JSON 对象，不要任何额外文字、不要 markdown 代码块包裹。结构：
{
  "itemType": "issue" | "pull_request",
  "needsReply": boolean,
  "draftReply": string,            // needsReply=true 时必填（PR 时是 review 总体正文）
  "reviewPoints": [                // 仅 PR needsReply 时给；issue 留空数组
    { "path": string, "line": number|null, "severity": "blocker"|"suggestion"|"nit"|"question",
      "comment": string, "evidence": string }
  ],
  "suggestedAction": "none" | "close_issue" | "approve_pr" | "request_changes_pr" | "close_pr" | "add_labels",
  "labels": string[],              // suggestedAction=add_labels 时必填
  "reasoning": string,
  "confidence": number             // 0-1
}`;

export function buildUserPrompt(item: TriageItem): string {
  const parts: string[] = [];
  parts.push(`仓库: ${item.owner}/${item.repo}`);
  parts.push(
    `类型: ${item.itemType === "pull_request" ? "Pull Request" : "Issue"}  #${item.number}`,
  );
  parts.push(`标题: ${item.title}`);
  parts.push(`作者: ${item.author}`);
  parts.push(`状态: ${item.state}`);
  parts.push(`链接: ${item.htmlUrl}`);
  if (item.labels.length) parts.push(`现有标签: ${item.labels.join(", ")}`);
  if (item.itemType === "pull_request") {
    parts.push(`草稿 PR: ${item.isDraft ? "是" : "否"}`);
  }
  parts.push(`\n=== 正文 ===\n${item.body || "(空)"}`);

  if (item.files?.length) {
    parts.push(
      `\n=== 改动（带新文件行号，reviewPoints 的 line 只能用这些行号）===\n${numberedDiff(item.files)}`,
    );
  } else if (item.diffSummary) {
    parts.push(`\n=== 改动摘要 / diff ===\n${item.diffSummary}`);
  }

  if (item.comments.length) {
    const c = item.comments
      .map((x) => `[${x.author} @ ${x.createdAt}]\n${x.body}`)
      .join("\n---\n");
    parts.push(`\n=== 最近评论 (由旧到新) ===\n${c}`);
  } else {
    parts.push(`\n=== 最近评论 ===\n(无)`);
  }

  parts.push(`\n请按 system 里的要求输出判定 JSON。`);
  return parts.join("\n");
}

/** Render each file's patch with new-file line numbers so the model can anchor points. */
function numberedDiff(files: { path: string; patch: string }[]): string {
  return files
    .map((f) => {
      const body = parsePatch(f.patch)
        .map((l) => {
          if (l.type === "hunk") return `        ${l.text}`;
          const num = l.newLine != null ? String(l.newLine).padStart(6) : "      ";
          const sign = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
          return `${num} ${sign}${l.text}`;
        })
        .join("\n");
      return `--- ${f.path} ---\n${body}`;
    })
    .join("\n\n");
}
