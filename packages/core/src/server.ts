import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import type { Store, PendingDecision } from "./store.ts";
import type { TriageEngine } from "./engine.ts";
import type { SuggestedAction } from "./judge/schema.ts";
import { parseSettings, type AppConfig } from "./config.ts";
import { parsePatch, commentableLines, type DiffLine } from "./diff.ts";
import { submitPrReview, type InlineComment } from "./github/actions.ts";

const REPLY_RE = /^\/reply\/([A-Za-z0-9_-]+)\/?$/;
const REVIEW_RE = /^\/review\/([A-Za-z0-9_-]+)\/?$/;
const CARD_ACTION_RE = /^\/card\/([A-Za-z0-9_-]+)\/(reply|act|ignore)\/?$/;

/**
 * Local HTTP service that IS the app UI (the desktop shell loads these pages):
 *  - GET  /                    → /inbox
 *  - GET  /inbox               open cards with action buttons + recent history
 *  - POST /card/<id>/<action>  reply (with optional edited text) / act / ignore
 *  - GET  /reply/<id>          issue draft preview (read-only)
 *  - GET  /review/<id>?t=tok   PR review page: per-point checklist + code
 *  - POST /review/<id>?t=tok   submit the selected points as one PR review
 *  - GET  /settings            settings panel (repos, tokens, intervals)
 *  - POST /settings            save settings (JSON body)
 * Binds 127.0.0.1 only. The WHOLE UI is gated by a per-install session token (the
 * app window's URL carries ?auth=…, then a cookie takes over) so other local
 * processes can't read or drive it. Card mutations additionally carry the per-card
 * token as a hidden field.
 */
export function startHttpServer(
  store: Store,
  engine: TriageEngine,
  port: number,
  hooks?: { onSettingsChanged?: (config: AppConfig) => void },
): Promise<number> {
  const uiToken = store.getOrCreateUiToken();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      // UI session gate: accept the token via ?auth=… once, then via cookie.
      const cookieOk = (req.headers.cookie ?? "")
        .split(/;\s*/)
        .includes(`ui=${uiToken}`);
      const queryOk = url.searchParams.get("auth") === uiToken;
      if (!cookieOk && !queryOk) {
        return send(res, 403, page("无权访问", "<p>缺少或错误的访问令牌。请从应用窗口打开本页面。</p>"));
      }
      if (queryOk && !cookieOk) {
        res.setHeader(
          "set-cookie",
          `ui=${uiToken}; Path=/; HttpOnly; SameSite=Strict`,
        );
      }

      if (req.method === "GET" && (path === "/" || path === "/inbox")) {
        // First run: nothing configured yet — take the user to the settings panel.
        if (!store.getSettingsRaw()) {
          res.writeHead(302, { location: "/settings" });
          return res.end();
        }
        return send(res, 200, renderInbox(store));
      }

      if (path === "/settings") {
        if (req.method === "GET")
          return send(res, 200, renderSettingsPage(store, engine));
        if (req.method === "POST")
          return handleSaveSettings(store, req, res, hooks?.onSettingsChanged);
      }

      const action = path.match(CARD_ACTION_RE);
      if (req.method === "POST" && action) {
        return handleCardAction(store, engine, action[1], action[2], req, res);
      }

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
          return handleSubmit(engine, p, req, res);
      }

      send(res, 404, page("未找到", "<p>Not found</p>"));
    } catch (err) {
      console.error("[http] handler error:", (err as Error).message);
      send(res, 500, page("出错了", "<p>Internal error</p>"));
    }
  });
  // Listen and report the ACTUAL bound port. port 0 = let the OS pick a free one
  // (the default — the desktop shell learns the port from the ready message, so
  // nothing depends on a fixed number). A pinned port that's already taken falls
  // back to an auto-assigned one instead of failing.
  return new Promise((resolve, reject) => {
    const tryListen = (p: number, fallbackToAuto: boolean): void => {
      const onStartupError = (err: Error): void => {
        if ((err as NodeJS.ErrnoException).code === "EADDRINUSE" && fallbackToAuto) {
          console.warn(`[http] port ${p} is in use — falling back to an auto-assigned port`);
          // Drop the stale 'listening' callback the failed listen() left behind,
          // or the retry would fire both and log/resolve twice.
          server.removeAllListeners("listening");
          tryListen(0, false);
        } else {
          reject(err);
        }
      };
      server.once("error", onStartupError);
      server.listen(p, "127.0.0.1", () => {
        // Startup races are settled; from here just log runtime errors.
        server.removeListener("error", onStartupError);
        server.on("error", (err) =>
          console.error("[http] server error:", (err as Error).message),
        );
        const actual = (server.address() as { port: number }).port;
        console.log(`[http] app pages on http://127.0.0.1:${actual}/inbox`);
        resolve(actual);
      });
    };
    tryListen(port, port !== 0);
  });
}

// ---- inbox (the main app view) ----

const ACTION_LABEL: Record<SuggestedAction, string> = {
  none: "无动作",
  close_issue: "关闭 issue",
  approve_pr: "批准 PR",
  request_changes_pr: "要求修改 PR",
  close_pr: "关闭 PR",
  add_labels: "打标签",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  awaiting_edit: "待处理",
  replied: "已回复",
  executed: "已执行",
  ignored: "已忽略",
  superseded: "已被取代",
};

function renderInbox(store: Store): string {
  const open = store.listOpen();
  const openIds = new Set(open.map((p) => p.id));
  const recent = store.listRecent(20).filter((p) => !openIds.has(p.id));

  const cards = open.map(renderInboxCard).join("");
  const history = recent
    .map((p) => {
      const typeLabel = p.itemType === "pull_request" ? "PR" : "Issue";
      return `<li class="hist"><span class="chip st-${esc(p.status)}">${esc(STATUS_LABEL[p.status] ?? p.status)}</span>
        <a href="${esc(p.htmlUrl)}" target="_blank" rel="noopener">${esc(p.owner)}/${esc(p.repo)} ${typeLabel} #${p.number}</a>
        <span class="meta">${esc(clip(p.title, 80))}</span></li>`;
    })
    .join("");

  return page(
    `Inbox (${open.length})`,
    `<h1>📥 待处理 <span class="count">${open.length}</span> <a class="gear" href="/settings" title="设置">⚙️</a></h1>
     ${cards || `<p class="meta">没有待处理的卡片。轮询会自动带来新的判定。</p>`}
     ${history ? `<h2>最近处理</h2><ul class="histlist">${history}</ul>` : ""}`,
    { refreshSeconds: 60 },
  );
}

// ---- settings panel ----

function renderSettingsPage(store: Store, engine: TriageEngine): string {
  const raw = (store.getSettingsRaw() ?? {}) as Record<string, any>;
  const repos: any[] = Array.isArray(raw.repos) && raw.repos.length ? raw.repos : [{}];
  const v = (x: unknown, d: string): string => esc(String(x ?? d));

  const repoRow = (r: Record<string, any>): string => {
    const watch: string[] = Array.isArray(r.watch) ? r.watch : ["issues", "pulls"];
    const others = r.only_from_others !== false;
    const ignores = Array.isArray(r.ignore_authors) ? r.ignore_authors.join(", ") : "";
    return `<div class="repo">
      <input class="r-url" type="text" placeholder="https://github.com/owner/repo" value="${esc(r.url ?? "")}">
      <label><input class="r-issues" type="checkbox" ${watch.includes("issues") ? "checked" : ""}> Issues</label>
      <label><input class="r-pulls" type="checkbox" ${watch.includes("pulls") ? "checked" : ""}> PRs</label>
      <label title="只处理非维护者发起的条目"><input class="r-others" type="checkbox" ${others ? "checked" : ""}> 仅他人</label>
      <input class="r-ignore" type="text" placeholder="忽略作者,逗号分隔" value="${esc(ignores)}">
      <button type="button" class="ghost" onclick="this.parentElement.remove()">✕</button>
    </div>`;
  };

  return page(
    "设置",
    `<h1>⚙️ 设置</h1>
     <p class="meta"><a href="/inbox">← Inbox</a> · 引擎状态: ${engine.configured ? "🟢 运行中" : "⚪️ 未配置（保存后自动启动）"}</p>

     <h2>认证</h2>
     <label class="field">GitHub Token（需要对所watch仓库的写权限）
       <input id="s-github" type="password" autocomplete="off" value="${v(raw.github_token, "")}"></label>
     <label class="field">Claude Token（可选。留空 = 使用本机 Claude Code 登录态；sk-ant-… 视为 API Key，其余视为订阅 OAuth token）
       <input id="s-claude" type="password" autocomplete="off" value="${v(raw.claude_token, "")}"></label>

     <h2>判定与轮询</h2>
     <div class="grid">
       <label class="field">判定模型
         <input id="s-model" type="text" value="${v(raw.model, "claude-opus-4-8")}"></label>
       <label class="field">轮询间隔（分钟）
         <input id="s-interval" type="number" min="1" value="${v(raw.poll_interval_minutes, "5")}"></label>
       <label class="field">首次回看天数
         <input id="s-lookback" type="number" min="1" value="${v(raw.lookback_days_on_first_run, "7")}"></label>
       <label class="field">提醒间隔（小时，0 关闭）
         <input id="s-remind" type="number" min="0" value="${v(raw.reminder_after_hours, "24")}"></label>
       <label class="field">本地端口（0 = 自动分配，避免冲突；重启后生效）
         <input id="s-port" type="number" min="0" value="${v(raw.http?.port, "0")}"></label>
     </div>

     <h2>仓库</h2>
     <div id="repos">${repos.map(repoRow).join("")}</div>
     <button type="button" class="ghost" onclick="addRepo()">＋ 添加仓库</button>
     <template id="repo-tpl">${repoRow({})}</template>

     <div class="actions" style="margin-top:1.5rem">
       <button onclick="save()">💾 保存并应用</button>
       <span id="s-msg" class="meta"></span>
     </div>

     <script>
     function addRepo(){
       document.getElementById('repos').appendChild(
         document.getElementById('repo-tpl').content.cloneNode(true));
     }
     function collect(){
       var repos=[];
       for (var el of document.querySelectorAll('#repos .repo')){
         var url=el.querySelector('.r-url').value.trim();
         if(!url) continue;
         var watch=[];
         if(el.querySelector('.r-issues').checked) watch.push('issues');
         if(el.querySelector('.r-pulls').checked) watch.push('pulls');
         repos.push({url:url, watch:watch,
           only_from_others:el.querySelector('.r-others').checked,
           ignore_authors:el.querySelector('.r-ignore').value.split(',').map(function(s){return s.trim()}).filter(Boolean)});
       }
       return {
         github_token:document.getElementById('s-github').value.trim(),
         claude_token:document.getElementById('s-claude').value.trim(),
         model:document.getElementById('s-model').value.trim(),
         poll_interval_minutes:Number(document.getElementById('s-interval').value),
         lookback_days_on_first_run:Number(document.getElementById('s-lookback').value),
         reminder_after_hours:Number(document.getElementById('s-remind').value),
         http:{port:Number(document.getElementById('s-port').value)},
         repos:repos
       };
     }
     async function save(){
       var msg=document.getElementById('s-msg');
       msg.textContent='保存中…';
       try{
         var res=await fetch('/settings',{method:'POST',
           headers:{'content-type':'application/json'},
           body:JSON.stringify(collect())});
         var out=await res.json();
         if(out.ok){ msg.textContent='✅ 已保存并应用，正在跳转…'; setTimeout(function(){location.href='/inbox'},800); }
         else{ msg.textContent='❌ '+out.error; }
       }catch(e){ msg.textContent='❌ '+e; }
     }
     </script>`,
  );
}

async function handleSaveSettings(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  onSettingsChanged?: (config: AppConfig) => void,
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { ok: false, error: "无效的 JSON" });
  }
  const parsed = parseSettings(raw);
  if (!parsed.ok) {
    return sendJson(res, 422, { ok: false, error: parsed.error });
  }
  // Persist the zod-normalized document (defaults filled in), then hot-apply.
  store.saveSettingsRaw(parsed.settings);
  onSettingsChanged?.(parsed.config);
  console.log("[settings] saved and applied");
  sendJson(res, 200, { ok: true });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": buf.length,
  });
  res.end(buf);
}

function renderInboxCard(p: PendingDecision): string {
  const d = p.decision;
  const typeLabel = p.itemType === "pull_request" ? "PR" : "Issue";
  const conf = Math.round(d.confidence * 100);
  const tok = `<input type="hidden" name="token" value="${esc(p.token)}">`;
  const ignoreForm = `<form method="post" action="/card/${p.id}/ignore" class="inline">${tok}<button class="ghost">🚫 忽略</button></form>`;

  let body: string;
  if (d.needsReply && p.itemType === "pull_request") {
    const url = `/review/${p.id}?t=${encodeURIComponent(p.token)}`;
    body = `<p>🔎 PR 审查意见 <b>${d.reviewPoints.length}</b> 条</p>
      <div class="actions"><a class="btn" href="${url}">🔎 逐条审核并提交</a>${ignoreForm}</div>`;
  } else if (d.needsReply) {
    const en = d.draftReply ?? "";
    const zh = d.draftReplyZh?.trim();
    body = `<details><summary>💬 草稿回复（点开审阅/编辑）</summary>
      ${zh ? `<div class="lang-zh"><pre>${esc(zh)}</pre></div>` : ""}
      <form method="post" action="/card/${p.id}/reply">${tok}
        <textarea name="body" rows="6">${esc(en)}</textarea>
        <div class="actions"><button>✅ 批准并回复</button></div>
      </form></details>
      <div class="actions">${ignoreForm}</div>`;
  } else {
    const label = ACTION_LABEL[d.suggestedAction];
    const labels =
      d.suggestedAction === "add_labels" && d.labels.length
        ? `<p>🏷 ${esc(d.labels.join(", "))}</p>`
        : "";
    const act =
      d.suggestedAction === "none"
        ? ""
        : `<form method="post" action="/card/${p.id}/act" class="inline">${tok}<button>✅ 执行「${esc(label)}」</button></form>`;
    body = `<p>🛠 建议动作: <b>${esc(label)}</b></p>${labels}
      <div class="actions">${act}${ignoreForm}</div>`;
  }

  return `<div class="card">
    <div class="cardhead"><b>${esc(p.owner)}/${esc(p.repo)}</b> · ${typeLabel} <b>#${p.number}</b>
      · <a href="${esc(p.htmlUrl)}" target="_blank" rel="noopener">在 GitHub 打开</a></div>
    <div class="title">${esc(clip(p.title, 200))}</div>
    <div class="reasoning">🧠 ${esc(clip(d.reasoning, 600))} <span class="meta">(置信度 ${conf}%)</span></div>
    ${body}
  </div>`;
}

async function handleCardAction(
  store: Store,
  engine: TriageEngine,
  id: string,
  action: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const p = store.getPending(id);
  if (!p) return send(res, 404, page("未找到", "<p>卡片不存在。</p>"));
  const form = new URLSearchParams(await readBody(req));
  if ((form.get("token") ?? "") !== p.token) {
    return send(res, 403, page("无权访问", "<p>token 不匹配。</p>"));
  }

  try {
    if (action === "ignore") {
      engine.ignore(id);
    } else if (action === "act") {
      await engine.executeAction(id);
    } else {
      const text = (form.get("body") ?? "").trim();
      await engine.approveReply(id, text || undefined);
    }
  } catch (e) {
    return send(
      res,
      502,
      page(
        "操作失败",
        `<h1>❌ 操作失败</h1><p>${esc((e as Error).message)}</p>
         <p class="meta">卡片状态未变，可回到 Inbox 重试。</p><p><a href="/inbox">← 返回 Inbox</a></p>`,
      ),
    );
  }
  res.writeHead(303, { location: "/inbox" });
  res.end();
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// ---- issue draft page (read-only) ----
function serveReply(store: Store, id: string, res: ServerResponse): void {
  const p = store.getPending(id);
  if (!p) return send(res, 404, page("未找到", "<p>该草稿不存在或已过期。</p>"));
  const typeLabel = p.itemType === "pull_request" ? "PR" : "Issue";
  const en = p.decision.draftReply?.trim() || "(no draft)";
  const zh = p.decision.draftReplyZh?.trim() || en; // fallback to EN on old cards
  send(
    res,
    200,
    page(
      `${p.owner}/${p.repo} #${p.number}`,
      `<h1>${esc(p.owner)}/${esc(p.repo)} · ${typeLabel} #${p.number}</h1>
       <p class="meta"><a href="/inbox">← Inbox</a> · <a href="${esc(p.htmlUrl)}" target="_blank" rel="noopener">在 GitHub 打开</a> · 状态: ${esc(p.status)}</p>
       <h2>判断依据</h2><p>${esc(p.decision.reasoning)}</p>
       ${LANG_TABS}
       <div class="lang-zh"><h2>草稿回复（中文，仅供理解）</h2><pre>${esc(zh)}</pre></div>
       <div class="lang-en"><h2>Draft reply (English — this is what gets posted)</h2><pre>${esc(en)}</pre></div>`,
    ),
  );
}

// ---- PR review page ----
function renderReviewPage(p: PendingDecision): string {
  const d = p.decision;
  const files = p.context?.files ?? [];
  // Parse each file's patch once and reuse it for anchoring, snippets and the full
  // diff — a point-heavy PR would otherwise re-parse the same patch many times.
  const parsedByPath = new Map(files.map((f) => [f.path, parsePatch(f.patch)]));
  const commentableCache = new Map<string, Set<number>>();
  const commentableFor = (path: string): Set<number> => {
    let s = commentableCache.get(path);
    if (!s) {
      const lines = parsedByPath.get(path);
      s = lines ? commentableFrom(lines) : new Set<number>();
      commentableCache.set(path, s);
    }
    return s;
  };
  const overallEn = d.draftReply?.trim() || "";
  const overallZh = d.draftReplyZh?.trim() || "";
  const done = p.status !== "pending" && p.status !== "awaiting_edit";

  const items = d.reviewPoints
    .map((pt, i) => {
      const lines = parsedByPath.get(pt.path);
      const anchored = pt.line != null && lines ? commentableFor(pt.path).has(pt.line) : false;
      const loc = `${esc(pt.path)}${pt.line != null ? `:${pt.line}` : ""}`;
      const warn = anchored ? "" : ` <span class="warn">（无法定位到改动行，将进 review 正文）</span>`;
      const code = pt.line != null && lines ? snippet(lines, pt.line) : "";
      return `<li class="pt">
        <label><input type="checkbox" name="pt" value="${i}" checked ${done ? "disabled" : ""}>
          <span class="sev sev-${esc(pt.severity)}">${esc(pt.severity)}</span>
          <code>${loc}</code>${warn}</label>
        <div class="cmt lang-zh">${esc(pt.commentZh || pt.comment)}</div>
        <div class="en lang-en">${esc(pt.comment)}</div>
        ${pt.evidence ? `<div class="ev">依据：${esc(pt.evidence)}</div>` : ""}
        ${code ? `<pre class="code">${code}</pre>` : ""}
      </li>`;
    })
    .join("");

  const list = `<ul class="pts">${items || "<li>（无逐行意见，提交后仅发送总体意见正文）</li>"}</ul>`;
  const zhBlock = `<div class="lang-zh"><h2>总体意见（中文，仅供理解）</h2><pre>${esc(overallZh || overallEn || "(none)")}</pre></div>`;
  const inner = done
    ? `${LANG_TABS}${zhBlock}
       <div class="lang-en"><h2>Review body (English — posted)</h2><pre>${esc(overallEn || "(none)")}</pre></div>
       <h2>逐条审查意见</h2>${list}
       <p class="meta">该 PR 已处理（状态：${esc(p.status)}），无法再次提交。</p>`
    : `${LANG_TABS}
       <form method="post" action="/review/${p.id}?t=${encodeURIComponent(p.token)}">
        ${zhBlock}
        <div class="lang-en"><h2>Review body (English — this is what gets posted, editable)</h2>
          <textarea name="body" rows="6" placeholder="Leave empty to post no overall body">${esc(overallEn)}</textarea></div>
        <h2>逐条审查意见（勾选采纳，未勾选不提交）</h2>
        ${list}
        <button type="submit">提交采纳项到 GitHub</button>
      </form>`;

  // Full diff, collapsed per file (files with review points open by default).
  // A big PR is thousands of diff-line <div>s; parsing/laying them all out up front
  // is what makes the page slow in the browser even after gzip. So only files with
  // review points render inline — the rest go into an inert <template> and are
  // materialized on first expand (see the toggle handler in page()), keeping the
  // initial DOM small regardless of PR size.
  const withPoints = new Set(d.reviewPoints.map((rp) => rp.path));
  const diffSection = files.length
    ? `<h2>改动 diff（按文件折叠）</h2>` +
      files
        .map((f) => {
          const lines = parsedByPath.get(f.path) ?? [];
          const body = `<pre class="code">${renderPatch(lines)}</pre>`;
          return withPoints.has(f.path)
            ? `<details open><summary>${esc(f.path)} · 有审查意见</summary>${body}</details>`
            : `<details><summary>${esc(f.path)}</summary><template>${body}</template></details>`;
        })
        .join("")
    : "";

  return page(
    `Review ${p.owner}/${p.repo} #${p.number}`,
    `<h1>🔎 ${esc(p.owner)}/${esc(p.repo)} · PR #${p.number}</h1>
     <p class="meta"><a href="/inbox">← Inbox</a> · <a href="${esc(p.htmlUrl)}" target="_blank" rel="noopener">在 GitHub 打开</a> · 状态: ${esc(p.status)}</p>
     <h2>判断依据（置信度 ${Math.round(d.confidence * 100)}%）</h2><p>${esc(d.reasoning)}</p>
     ${inner}
     ${diffSection}`,
  );
}

/** New-file lines GitHub accepts an inline comment on, from already-parsed lines. */
function commentableFrom(lines: DiffLine[]): Set<number> {
  const set = new Set<number>();
  for (const l of lines) {
    if ((l.type === "add" || l.type === "ctx") && l.newLine != null) set.add(l.newLine);
  }
  return set;
}

/** Render a whole file patch with new-file line numbers and +/- coloring. */
function renderPatch(lines: DiffLine[]): string {
  return lines
    .map((l) => {
      if (l.type === "hunk") return `<div class="dh">${esc(l.text)}</div>`;
      const num = l.newLine != null ? String(l.newLine).padStart(5) : "     ";
      const sign = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
      const cls = l.type === "add" ? "da" : l.type === "del" ? "dd" : "";
      return `<div class="${cls}">${esc(num)} ${esc(sign + l.text)}</div>`;
    })
    .join("");
}

/** A few lines of context around a target new-file line, with it highlighted. */
function snippet(lines: DiffLine[], line: number): string {
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
  engine: TriageEngine,
  p: PendingDecision,
  req: IncomingMessage,
  res: ServerResponse,
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
  engine.noteReviewSubmitted(
    p.id,
    `✅ 已提交 PR Review（行内 ${comments.length} 条）`,
    url,
  );
  send(
    res,
    200,
    page(
      "已提交",
      `<h1>✅ 已提交 PR Review</h1>
       <p>行内评论 ${comments.length} 条${body ? "，含总体正文" : ""}。</p>
       <p><a href="${esc(url)}" target="_blank" rel="noopener">在 GitHub 查看这次 review</a></p>
       <p><a href="/inbox">← 返回 Inbox</a></p>`,
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
  const body = Buffer.from(html, "utf8");
  const headers: Record<string, string | number> = {
    "content-type": "text/html; charset=utf-8",
  };
  // The review page inlines the whole PR diff and can reach several MB of highly
  // compressible text; gzip turns that into a few hundred KB so it opens fast even
  // over a slow tunnel. Compress any large body unless the client explicitly refuses
  // gzip: curl and other tools send no Accept-Encoding at all, which per HTTP means
  // "any encoding is fine", so we default to compressing and only bail when a header
  // is present that excludes gzip. Skip tiny bodies where it isn't worth it.
  const ae = String(res.req?.headers["accept-encoding"] ?? "");
  const rejectsGzip = ae !== "" && !/\bgzip\b/.test(ae) && !/[*]/.test(ae);
  if (!rejectsGzip && body.length > 1400) {
    const gz = gzipSync(body);
    headers["content-encoding"] = "gzip";
    headers["content-length"] = gz.length;
    res.writeHead(status, headers);
    res.end(gz);
    return;
  }
  headers["content-length"] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

/** Global language-tab UI: default Chinese, click to reveal English blocks. */
const LANG_TABS = `<div class="tabs"><button data-l="zh" class="active" onclick="setLang('zh')">中文</button><button data-l="en" onclick="setLang('en')">English</button></div>`;

function page(
  title: string,
  inner: string,
  opts?: { refreshSeconds?: number },
): string {
  return `<!doctype html><html lang="zh" data-lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts?.refreshSeconds ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">` : ""}
<title>${esc(title)}</title>
<style>
  body{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
  h1{font-size:1.25rem} h2{font-size:1rem;color:#555;margin-top:1.5rem}
  .meta{color:#666;font-size:.9rem}
  .tabs{display:flex;gap:.5rem;margin:1rem 0}
  .tabs button{font-size:.9rem;margin:0;padding:.3rem .9rem;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;color:inherit;cursor:pointer}
  .tabs button.active{background:#0969da;border-color:#0969da;color:#fff}
  [data-lang="zh"] .lang-en{display:none}
  [data-lang="en"] .lang-zh{display:none}
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
  details{border:1px solid #e1e4e8;border-radius:6px;margin:.5rem 0} details>summary{cursor:pointer;padding:.5rem .8rem;font-family:ui-monospace,monospace;font-size:.85rem;background:#f6f8fa}
  details pre.code{margin:0;border:0;border-top:1px solid #e1e4e8;border-radius:0;max-height:70vh;overflow:auto}
  .da{background:#e6ffec} .dd{background:#ffebe9} .dh{color:#8250df}
  button{font-size:1rem;padding:.5rem 1rem;border:0;border-radius:6px;background:#1f883d;color:#fff;cursor:pointer;margin-top:1rem}
  code{background:#eff1f3;padding:.05rem .3rem;border-radius:4px}
  textarea{width:100%;box-sizing:border-box;font:inherit;padding:.6rem;border:1px solid #e1e4e8;border-radius:6px;background:#f6f8fa;color:inherit}
  .card{border:1px solid #d0d7de;border-radius:10px;padding:1rem;margin:1rem 0}
  .cardhead{font-size:.9rem;color:#57606a} .card .title{font-weight:600;margin:.3rem 0}
  .reasoning{margin:.4rem 0}
  .count{font-size:.9rem;background:#0969da;color:#fff;border-radius:10px;padding:.1rem .5rem;vertical-align:middle}
  .actions{display:flex;gap:.5rem;align-items:center;margin-top:.5rem} form.inline{display:inline;margin:0}
  .actions button,a.btn{font-size:.9rem;padding:.4rem .9rem;margin:0;border:0;border-radius:6px;background:#1f883d;color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
  button.ghost{background:transparent;color:#57606a;border:1px solid #d0d7de}
  .chip{font-size:.75rem;font-weight:600;padding:.05rem .5rem;border-radius:10px;background:#eef;color:#555;margin-right:.4rem}
  .chip.st-replied,.chip.st-executed{background:#dafbe1;color:#1a7f37}
  .chip.st-ignored{background:#eee;color:#666} .chip.st-superseded{background:#fff5b1;color:#7a5b00}
  ul.histlist{list-style:none;padding:0} li.hist{padding:.25rem 0;font-size:.9rem}
  a.gear{float:right;text-decoration:none;font-size:1.1rem}
  label.field{display:block;margin:.6rem 0;font-size:.9rem;color:#57606a}
  label.field input{display:block;width:100%;box-sizing:border-box;margin-top:.25rem;font:inherit;padding:.45rem .6rem;border:1px solid #d0d7de;border-radius:6px;background:#fff;color:inherit}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:0 1rem}
  .repo{display:flex;gap:.5rem;align-items:center;margin:.4rem 0;flex-wrap:wrap}
  .repo input[type=text]{font:inherit;padding:.4rem .6rem;border:1px solid #d0d7de;border-radius:6px;background:#fff;color:inherit}
  .repo .r-url{flex:2;min-width:16rem} .repo .r-ignore{flex:1;min-width:8rem}
  .repo label{font-size:.85rem;color:#57606a;white-space:nowrap}
  @media(prefers-color-scheme:dark){
    body{background:#0d1117;color:#c9d1d9} pre,li.pt,textarea{background:#161b22;border-color:#30363d}
    h2,.meta,.ev{color:#8b949e} .en{color:#adbac7;border-color:#30363d} a{color:#58a6ff} code{background:#161b22}
    .card{border-color:#30363d} .cardhead{color:#8b949e}
    button.ghost{border-color:#30363d;color:#8b949e}
    .chip{background:#161b22;color:#8b949e} .chip.st-replied,.chip.st-executed{background:#12261e;color:#3fb950}
    .chip.st-ignored{background:#161b22;color:#666} .chip.st-superseded{background:#3f2e00;color:#d29922}
    label.field{color:#8b949e} label.field input,.repo input[type=text]{background:#161b22;border-color:#30363d}
    .repo label{color:#8b949e}
    pre.code .hl{background:#3f2e00}
    .tabs button{background:#161b22;border-color:#30363d} .tabs button.active{background:#1f6feb;border-color:#1f6feb;color:#fff}
    details,details>summary{border-color:#30363d} details>summary{background:#161b22} details pre.code{border-color:#30363d}
    .da{background:#12261e} .dd{background:#25171c} .dh{color:#a371f7}
  }
</style></head><body>${inner}
<script>
function setLang(l){document.documentElement.dataset.lang=l;
  for(var b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.l===l);}
// Materialize a file's deferred diff the first time its <details> is opened. The
// toggle event doesn't bubble, so listen in the capture phase.
document.addEventListener('toggle',function(e){
  var d=e.target;
  if(!d||d.tagName!=='DETAILS'||!d.open) return;
  var t=d.querySelector('template');
  if(!t) return;
  d.appendChild(t.content.cloneNode(true));
  t.remove();
},true);
</script></body></html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
