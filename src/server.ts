import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Store, PendingDecision } from "./store.ts";
import { parsePatch, commentableLines } from "./diff.ts";
import { submitPrReview, type InlineComment } from "./github/actions.ts";

type OnSubmitted = (id: string, receipt: string) => void;

const REPLY_RE = /^\/reply\/([A-Za-z0-9_-]+)\/?$/;
const REVIEW_RE = /^\/review\/([A-Za-z0-9_-]+)\/?$/;

/**
 * HTTP service backing the Telegram cards:
 *  - GET  /reply/<id>          issue draft preview (read-only, no token)
 *  - GET  /review/<id>?t=tok   PR review page: per-point checklist + code (token required)
 *  - POST /review/<id>?t=tok   submit the selected points as one PR review
 */
export function startHttpServer(
  store: Store,
  port: number,
  onSubmitted?: OnSubmitted,
): void {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      const reply = path.match(REPLY_RE);
      if (req.method === "GET" && reply) {
        return serveReply(store, reply[1], res);
      }

      const review = path.match(REVIEW_RE);
      if (review) {
        const p = store.getPending(review[1]);
        const token = url.searchParams.get("t") ?? "";
        if (!p || !p.token || token !== p.token) {
          return send(res, 403, page("无权访问", "<p>链接无效或缺少 token。</p>"));
        }
        if (req.method === "GET") return send(res, 200, renderReviewPage(p));
        if (req.method === "POST")
          return handleSubmit(store, p, req, res, onSubmitted);
      }

      send(res, 404, page("未找到", "<p>Not found</p>"));
    } catch (err) {
      console.error("[http] handler error:", (err as Error).message);
      send(res, 500, page("出错了", "<p>Internal error</p>"));
    }
  });
  server.on("error", (err) =>
    console.error("[http] server error:", (err as Error).message),
  );
  server.listen(port, () =>
    console.log(`[http] server listening on :${port}`),
  );
}

// ---- issue draft page (read-only) ----
function serveReply(store: Store, id: string, res: ServerResponse): void {
  const p = store.getPending(id);
  if (!p) return send(res, 404, page("未找到", "<p>该草稿不存在或已过期。</p>"));
  const typeLabel = p.itemType === "pull_request" ? "PR" : "Issue";
  const en = p.decision.draftReply?.trim() || "(no draft)";
  const zh = p.decision.draftReplyZh?.trim() || "";
  send(
    res,
    200,
    page(
      `${p.owner}/${p.repo} #${p.number}`,
      `<h1>${esc(p.owner)}/${esc(p.repo)} · ${typeLabel} #${p.number}</h1>
       <p class="meta"><a href="${esc(p.htmlUrl)}" target="_blank" rel="noopener">在 GitHub 打开</a> · 状态: ${esc(p.status)}</p>
       <h2>判断依据</h2><p>${esc(p.decision.reasoning)}</p>
       ${zh ? `<h2>草稿回复（中文，仅供理解）</h2><pre>${esc(zh)}</pre>` : ""}
       <h2>Draft reply (English — this is what gets posted)</h2><pre>${esc(en)}</pre>`,
    ),
  );
}

// ---- PR review page ----
function renderReviewPage(p: PendingDecision): string {
  const d = p.decision;
  const patchByPath = new Map((p.context?.files ?? []).map((f) => [f.path, f.patch]));
  const overallEn = d.draftReply?.trim() || "";
  const overallZh = d.draftReplyZh?.trim() || "";
  const done = p.status !== "pending" && p.status !== "awaiting_edit";

  const items = d.reviewPoints
    .map((pt, i) => {
      const patch = patchByPath.get(pt.path);
      const anchored =
        pt.line != null && patch ? commentableLines(patch).has(pt.line) : false;
      const loc = `${esc(pt.path)}${pt.line != null ? `:${pt.line}` : ""}`;
      const warn = anchored ? "" : ` <span class="warn">（无法定位到改动行，将进 review 正文）</span>`;
      const code = pt.line != null && patch ? snippet(patch, pt.line) : "";
      return `<li class="pt">
        <label><input type="checkbox" name="pt" value="${i}" checked ${done ? "disabled" : ""}>
          <span class="sev sev-${esc(pt.severity)}">${esc(pt.severity)}</span>
          <code>${loc}</code>${warn}</label>
        ${pt.commentZh ? `<div class="cmt">${esc(pt.commentZh)}</div>` : ""}
        <div class="en">EN (posted): ${esc(pt.comment)}</div>
        ${pt.evidence ? `<div class="ev">依据：${esc(pt.evidence)}</div>` : ""}
        ${code ? `<pre class="code">${code}</pre>` : ""}
      </li>`;
    })
    .join("");

  const list = `<ul class="pts">${items || "<li>（无逐行意见，提交后仅发送总体意见正文）</li>"}</ul>`;
  const zhBlock = overallZh
    ? `<h2>总体意见（中文，仅供理解）</h2><pre>${esc(overallZh)}</pre>`
    : "";
  const inner = done
    ? `${zhBlock}
       <h2>Review body (English — posted)</h2><pre>${esc(overallEn || "(none)")}</pre>
       <h2>逐条审查意见</h2>${list}
       <p class="meta">该 PR 已处理（状态：${esc(p.status)}），无法再次提交。</p>`
    : `${zhBlock}
       <form method="post" action="/review/${p.id}?t=${encodeURIComponent(p.token)}">
        <h2>Review body (English — this is what gets posted, editable)</h2>
        <textarea name="body" rows="6" placeholder="Leave empty to post no overall body">${esc(overallEn)}</textarea>
        <h2>逐条审查意见（勾选采纳，未勾选不提交）</h2>
        ${list}
        <button type="submit">提交采纳项到 GitHub</button>
      </form>`;

  return page(
    `Review ${p.owner}/${p.repo} #${p.number}`,
    `<h1>🔎 ${esc(p.owner)}/${esc(p.repo)} · PR #${p.number}</h1>
     <p class="meta"><a href="${esc(p.htmlUrl)}" target="_blank" rel="noopener">在 GitHub 打开</a> · 状态: ${esc(p.status)}</p>
     <h2>判断依据（置信度 ${Math.round(d.confidence * 100)}%）</h2><p>${esc(d.reasoning)}</p>
     ${inner}`,
  );
}

/** A few lines of context around a target new-file line, with it highlighted. */
function snippet(patch: string, line: number): string {
  const lines = parsePatch(patch);
  const idx = lines.findIndex((l) => l.newLine === line);
  if (idx < 0) return "";
  const from = Math.max(0, idx - 3);
  const to = Math.min(lines.length, idx + 4);
  return lines
    .slice(from, to)
    .map((l) => {
      const num = l.newLine != null ? String(l.newLine).padStart(5) : "     ";
      const sign = l.type === "add" ? "+" : l.type === "del" ? "-" : l.type === "hunk" ? "" : " ";
      const hl = l.newLine === line ? ' class="hl"' : "";
      return `<div${hl}>${esc(num)} ${esc(sign + l.text)}</div>`;
    })
    .join("");
}

async function handleSubmit(
  store: Store,
  p: PendingDecision,
  req: IncomingMessage,
  res: ServerResponse,
  onSubmitted?: OnSubmitted,
): Promise<void> {
  if (p.status !== "pending" && p.status !== "awaiting_edit") {
    return send(res, 409, page("已处理", "<p>该 PR 已处理过。</p>"));
  }
  const raw = await readBody(req);
  const form = new URLSearchParams(raw);
  const selected = form
    .getAll("pt")
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n));
  const overrideBody = form.get("body") ?? undefined; // edited review body

  const { body, comments } = buildReviewSubmission(p, selected, overrideBody);
  if (!body && comments.length === 0) {
    return send(res, 400, page("无内容", "<p>没有勾选任何意见，也没有总体正文，未提交。</p>"));
  }

  let url: string;
  try {
    url = await submitPrReview(p, body, comments);
  } catch (e) {
    // Keep the card pending so it can be retried after fixing the cause.
    const msg = (e as Error).message;
    const hint = /not accessible|403/i.test(msg)
      ? `<p class="meta">看起来是 GITHUB_TOKEN 权限不够：提交 PR review 需要该仓库的 <b>Pull requests: Write</b> 权限（细粒度 PAT 里勾 Pull requests / Read and write，或经典 PAT 勾 <code>repo</code>）。改好 token、重启后回到本页重新提交即可——本条尚未提交、状态未变。</p>`
      : "";
    return send(
      res,
      502,
      page("提交失败", `<h1>提交到 GitHub 失败</h1><p>${esc(msg)}</p>${hint}`),
    );
  }
  store.setPendingStatus(p.id, "replied");
  const receipt = `✅ 已提交 PR Review（行内 ${comments.length} 条）· 🔗 <a href="${esc(url)}">在 GitHub 查看</a>`;
  onSubmitted?.(p.id, receipt);
  send(
    res,
    200,
    page(
      "已提交",
      `<h1>✅ 已提交 PR Review</h1>
       <p>行内评论 ${comments.length} 条${body ? "，含总体正文" : ""}。</p>
       <p><a href="${esc(url)}" target="_blank" rel="noopener">在 GitHub 查看这次 review</a></p>`,
    ),
  );
}

/**
 * Build the GitHub review payload from selected point indices. Anchored points
 * (line present AND commentable in the diff) become inline comments; everything
 * else is appended to the review body so nothing is dropped and GitHub never 422s.
 */
export function buildReviewSubmission(
  p: PendingDecision,
  selected: number[],
  overrideBody?: string,
): { body: string; comments: InlineComment[] } {
  const d = p.decision;
  const patchByPath = new Map((p.context?.files ?? []).map((f) => [f.path, f.patch]));
  const commentableCache = new Map<string, Set<number>>();
  const commentableFor = (path: string): Set<number> => {
    let s = commentableCache.get(path);
    if (!s) {
      const patch = patchByPath.get(path);
      s = patch ? commentableLines(patch) : new Set<number>();
      commentableCache.set(path, s);
    }
    return s;
  };

  const comments: InlineComment[] = [];
  const extra: string[] = [];
  for (const i of selected) {
    const pt = d.reviewPoints[i];
    if (!pt) continue;
    if (pt.line != null && commentableFor(pt.path).has(pt.line)) {
      comments.push({ path: pt.path, line: pt.line, body: `**[${pt.severity}]** ${pt.comment}` });
    } else {
      const loc = `\`${pt.path}${pt.line != null ? `:${pt.line}` : ""}\``;
      extra.push(`- ${loc} **[${pt.severity}]** ${pt.comment}`);
    }
  }

  let body = (overrideBody ?? d.draftReply ?? "").trim();
  if (extra.length) {
    body += (body ? "\n\n" : "") + "**其他意见：**\n" + extra.join("\n");
  }
  return { body, comments };
}

// ---- helpers ----
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
  h1{font-size:1.25rem} h2{font-size:1rem;color:#555;margin-top:1.5rem}
  .meta{color:#666;font-size:.9rem}
  pre{white-space:pre-wrap;word-wrap:break-word;background:#f6f8fa;border:1px solid #e1e4e8;border-radius:6px;padding:1rem}
  a{color:#0969da}
  ul.pts{list-style:none;padding:0} li.pt{border:1px solid #e1e4e8;border-radius:8px;padding:.75rem 1rem;margin:.75rem 0}
  li.pt label{cursor:pointer} .cmt{margin:.4rem 0} .ev{color:#666;font-size:.9rem}
  .en{margin:.3rem 0;font-size:.9rem;color:#444;border-left:3px solid #d0d7de;padding-left:.5rem}
  .sev{font-size:.75rem;font-weight:600;padding:.05rem .4rem;border-radius:4px;margin:0 .3rem}
  .sev-blocker{background:#ffdce0;color:#b31d28} .sev-suggestion{background:#ddf4ff;color:#0969da}
  .sev-nit{background:#eef;color:#555} .sev-question{background:#fff5b1;color:#7a5b00}
  .warn{color:#b31d28;font-size:.8rem}
  pre.code{font-size:.85rem;padding:.5rem} pre.code .hl{background:#fff8c5}
  button{font-size:1rem;padding:.5rem 1rem;border:0;border-radius:6px;background:#1f883d;color:#fff;cursor:pointer;margin-top:1rem}
  code{background:#eff1f3;padding:.05rem .3rem;border-radius:4px}
  textarea{width:100%;box-sizing:border-box;font:inherit;padding:.6rem;border:1px solid #e1e4e8;border-radius:6px;background:#f6f8fa;color:inherit}
  @media(prefers-color-scheme:dark){
    body{background:#0d1117;color:#c9d1d9} pre,li.pt,textarea{background:#161b22;border-color:#30363d}
    h2,.meta,.ev{color:#8b949e} .en{color:#adbac7;border-color:#30363d} a{color:#58a6ff} code{background:#161b22}
    pre.code .hl{background:#3f2e00}
  }
</style></head><body>${inner}</body></html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
