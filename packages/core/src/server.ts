import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { recentLogs } from "./log.ts";
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
 * Local HTTP service that IS the app UI (the desktop shell loads these pages).
 * Mail-client layout: a fixed sidebar (待处理/已处理 folders grouped by repo,
 * 设置/日志 at the bottom) next to the content column.
 *  - GET  /                    → /inbox
 *  - GET  /setup               first-run wizard: step 1 model, step 2 GitHub (no repos)
 *  - GET  /inbox?view=open|done&repo=owner/repo   folder views
 *  - GET  /logs                recent runtime log lines (in-memory ring buffer)
 *  - POST /repos/add|remove    add/remove a watched repo from the Inbox page
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
        // First run: nothing configured yet — take the user through the wizard.
        if (!store.getSettingsRaw()) {
          res.writeHead(302, { location: "/setup" });
          return res.end();
        }
        const view = url.searchParams.get("view") === "done" ? "done" : "open";
        const repoFilter = url.searchParams.get("repo") ?? undefined;
        return send(res, 200, renderInbox(store, view, repoFilter));
      }

      if (req.method === "GET" && path === "/logs") {
        return send(res, 200, renderLogsPage(store));
      }

      if (req.method === "GET" && path === "/setup") {
        // The wizard is for first run only; afterwards the full panel takes over.
        if (store.getSettingsRaw()) {
          res.writeHead(302, { location: "/settings" });
          return res.end();
        }
        return send(res, 200, renderSetupWizard());
      }

      if (req.method === "POST" && (path === "/repos/add" || path === "/repos/remove")) {
        return handleRepoMutation(
          store,
          path === "/repos/add" ? "add" : "remove",
          req,
          res,
          hooks?.onSettingsChanged,
        );
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
        if (req.method === "GET")
          return send(res, 200, renderReviewPage(p, renderSidebar(store, { view: "open" })));
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

/** Watched repos from settings as "owner/repo" keys (tolerates unparsable URLs). */
function watchedRepoKeys(store: Store): { key: string; url: string }[] {
  const raw = (store.getSettingsRaw() ?? {}) as Record<string, any>;
  const repos: any[] = Array.isArray(raw.repos) ? raw.repos : [];
  const out: { key: string; url: string }[] = [];
  for (const r of repos) {
    const url = String(r?.url ?? "");
    const m = url.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
    if (m) out.push({ key: `${m[1]}/${m[2].replace(/\.git$/, "")}`, url });
  }
  return out;
}

/**
 * The mail-client sidebar: 待处理/已处理 folders with per-repo sub-folders,
 * 设置/日志 pinned at the bottom. `active` marks the current view for highlight.
 */
function renderSidebar(
  store: Store,
  active: { view: "open" | "done" | "settings" | "logs"; repo?: string },
): string {
  const counts = store.countByRepo();
  const byKey = new Map(counts.map((c) => [`${c.owner}/${c.repo}`, c]));
  // Folder list = watched repos (even if empty) ∪ repos that still have cards.
  const keys = [...new Set([...watchedRepoKeys(store).map((r) => r.key), ...byKey.keys()])].sort();
  const totalOpen = counts.reduce((n, c) => n + c.open, 0);
  const totalDone = counts.reduce((n, c) => n + c.done, 0);

  const item = (
    href: string,
    label: string,
    opts: { count?: number; hot?: boolean; sub?: boolean; on?: boolean; icon?: string },
  ): string =>
    `<a href="${esc(href)}" class="${opts.sub ? "sub" : ""}${opts.on ? " active" : ""}">
      ${opts.icon ? `<span class="ic">${opts.icon}</span>` : ""}<span class="lbl">${esc(label)}</span>
      ${opts.count ? `<span class="scount${opts.hot ? " hot" : ""}">${opts.count}</span>` : ""}
    </a>`;

  const folder = (view: "open" | "done", icon: string, label: string, total: number): string => {
    const rows = keys
      .map((k) => {
        const c = byKey.get(k);
        const n = view === "open" ? (c?.open ?? 0) : (c?.done ?? 0);
        return item(`/inbox?view=${view}&repo=${encodeURIComponent(k)}`, k, {
          count: n,
          hot: view === "open" && n > 0,
          sub: true,
          on: active.view === view && active.repo === k,
        });
      })
      .join("");
    return (
      item(`/inbox?view=${view}`, label, {
        icon,
        count: total,
        hot: view === "open" && total > 0,
        on: active.view === view && !active.repo,
      }) + rows
    );
  };

  return `<aside class="side">
    <div class="sbrand">🤖 GH Triage</div>
    <nav class="snav">
      ${folder("open", "📥", "待处理", totalOpen)}
      <div class="sgap"></div>
      ${folder("done", "✅", "已处理", totalDone)}
    </nav>
    <div class="sfoot">
      ${item("/settings", "设置", { icon: "⚙️", on: active.view === "settings" })}
      ${item("/logs", "日志", { icon: "📜", on: active.view === "logs" })}
    </div>
  </aside>`;
}

function renderInbox(store: Store, view: "open" | "done", repoFilter?: string): string {
  const side = renderSidebar(store, { view, repo: repoFilter });
  const inRepo = (p: PendingDecision): boolean =>
    !repoFilter || `${p.owner}/${p.repo}` === repoFilter;
  const suffix = repoFilter ? ` · ${esc(repoFilter)}` : "";

  if (view === "done") {
    const done = store.listDone(200).filter(inRepo);
    const rows = done
      .map((p) => {
        const typeLabel = p.itemType === "pull_request" ? "PR" : "Issue";
        const when = new Date(p.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
        return `<li class="hist"><span class="chip st-${esc(p.status)}">${esc(STATUS_LABEL[p.status] ?? p.status)}</span>
          <span class="tag ${p.itemType === "pull_request" ? "tag-pr" : "tag-issue"}">${typeLabel}</span>
          <a href="${esc(p.htmlUrl)}" target="_blank" rel="noopener">${esc(p.owner)}/${esc(p.repo)} #${p.number}</a>
          <span class="meta lbl">${esc(clip(p.title, 90))}</span>
          <span class="meta when">${esc(when)}</span></li>`;
      })
      .join("");
    return page(
      `已处理${repoFilter ? ` · ${repoFilter}` : ""}`,
      `<h1>已处理${suffix}</h1>
       ${rows
         ? `<div class="panel"><ul class="histlist">${rows}</ul></div>`
         : `<div class="empty"><span class="big">🗂</span>还没有已处理的记录${suffix ? "" : "<br><span class=\"meta\">回复 / 执行 / 忽略过的卡片会归档到这里</span>"}</div>`}`,
      { refreshSeconds: 60, side },
    );
  }

  const open = store.listOpen().filter(inRepo);
  const cards = open.map(renderInboxCard).join("");

  const watched = watchedRepoKeys(store);
  const rawRepos = ((store.getSettingsRaw() ?? {}) as Record<string, any>).repos ?? [];
  const repoRows = (Array.isArray(rawRepos) ? rawRepos : [])
    .map((r: any) => {
      const watch: string[] = Array.isArray(r.watch) ? r.watch : ["issues", "pulls"];
      return `<li class="hist"><code>${esc(String(r.url ?? "").replace(/^https?:\/\/(www\.)?github\.com\//i, ""))}</code>
        <span class="chip">${watch.includes("issues") ? "Issues" : ""}${watch.length === 2 ? " + " : ""}${watch.includes("pulls") ? "PRs" : ""}</span>
        <form method="post" action="/repos/remove" class="inline">
          <input type="hidden" name="url" value="${esc(String(r.url ?? ""))}">
          <button class="ghost" title="停止监控该仓库">✕</button>
        </form></li>`;
    })
    .join("");
  // Repo management lives on the all-pending view only (folder root, mail-style).
  const repoSection = repoFilter
    ? ""
    : `<h2>📦 监控的仓库（${watched.length}）</h2>
     <div class="panel">
       ${repoRows ? `<ul class="histlist">${repoRows}</ul>` : ""}
       <form method="post" action="/repos/add" class="addrepo">
         <input type="text" name="url" placeholder="https://github.com/owner/repo" required>
         <button>＋ 添加仓库</button>
       </form>
       <p class="meta" style="margin:.3rem 0 0">高级选项（只看他人 / 忽略作者 / 只看 Issues 或 PRs）在<a href="/settings">设置</a>里调整。</p>
     </div>`;

  const emptyState = watched.length
    ? `<div class="empty"><span class="big">☕️</span>没有待处理的卡片<br><span class="meta">轮询每隔几分钟运行一次，新的判定会自动出现在这里</span></div>`
    : `<div class="empty"><span class="big">📦</span>还没有监控任何仓库<br><span class="meta">在下方添加一个 GitHub 仓库，轮询就会开始</span></div>`;

  return page(
    `Inbox (${open.length})`,
    `<h1>待处理${suffix}${open.length ? `<span class="count">${open.length}</span>` : ""}</h1>
     ${cards || emptyState}
     ${repoSection}`,
    { refreshSeconds: 60, side },
  );
}

// ---- logs page ----

function renderLogsPage(store: Store): string {
  const lines = recentLogs();
  const rows = lines
    .map((l) => {
      const t = new Date(l.ts).toLocaleTimeString("zh-CN", { hour12: false });
      const cls = l.level === "error" ? "le" : l.level === "warn" ? "lw" : "";
      return `<div class="ll ${cls}">[${t}] ${esc(l.text)}</div>`;
    })
    .join("");
  return page(
    "运行日志",
    `<h1>运行日志</h1>
     <p class="meta">进程启动以来的最近 ${lines.length} 行（内存保留上限 1000 行，重启后清空）· 每 15 秒自动刷新</p>
     <div class="logbox" id="logbox">${rows || `<div class="ll meta">（暂无日志输出）</div>`}</div>
     <script>var lb=document.getElementById('logbox');lb.scrollTop=lb.scrollHeight;</script>`,
    { refreshSeconds: 15, side: renderSidebar(store, { view: "logs" }) },
  );
}

// ---- first-run setup wizard (model → GitHub; repos are added later on /inbox) ----

function renderSetupWizard(): string {
  return page(
    "初始设置",
    `<div class="wizard">
     <div class="whead">
       <span class="logo">🤖</span>
       <h1>欢迎使用 GH Triage</h1>
       <p class="meta">两步完成初始设置。仓库不在这里添加 —— 完成后在 Inbox 主界面随时添加。</p>
     </div>

     <div class="steps">
       <span class="step on" id="ind1"><span class="dot">1</span>模型设置</span>
       <span class="line"></span>
       <span class="step" id="ind2"><span class="dot">2</span>GitHub 设置</span>
     </div>

     <div class="panel" id="step1">
       <label class="field">判定模型
         <input id="w-model" type="text" list="w-models" value="claude-opus-4-8"></label>
       <datalist id="w-models">
         <option value="claude-opus-4-8"></option>
         <option value="claude-sonnet-5"></option>
         <option value="claude-haiku-4-5-20251001"></option>
       </datalist>
       <label class="field">Claude Token（可选。留空 = 使用本机 Claude Code 登录态；sk-ant-oat… 视为订阅 OAuth token，其他 sk-ant-… 视为 API Key）
         <input id="w-claude" type="password" autocomplete="off"></label>
       <div class="actions"><button onclick="go(2)">下一步 →</button></div>
     </div>

     <div class="panel" id="step2" style="display:none">
       <label class="field">GitHub Token（需要对所监控仓库的写权限：细粒度 PAT 勾 Issues / Pull requests 的 Read and write，或经典 PAT 勾 <code>repo</code>）
         <input id="w-github" type="password" autocomplete="off"></label>
       <div class="actions">
         <button type="button" class="ghost" onclick="go(1)">← 上一步</button>
         <button onclick="finish()">完成并进入 Inbox</button>
         <span id="w-msg" class="meta"></span>
       </div>
     </div>
     </div>

     <script>
     function go(n){
       document.getElementById('step1').style.display = n===1 ? '' : 'none';
       document.getElementById('step2').style.display = n===2 ? '' : 'none';
       document.getElementById('ind1').className = 'step ' + (n===1 ? 'on' : 'done');
       document.getElementById('ind2').className = 'step ' + (n===2 ? 'on' : '');
       document.getElementById('ind1').querySelector('.dot').textContent = n===2 ? '✓' : '1';
     }
     async function finish(){
       var msg=document.getElementById('w-msg');
       var gh=document.getElementById('w-github').value.trim();
       if(!gh){ msg.textContent='❌ GitHub Token 不能为空'; return; }
       msg.textContent='保存中…';
       try{
         var res=await fetch('/settings',{method:'POST',
           headers:{'content-type':'application/json'},
           body:JSON.stringify({
             github_token: gh,
             claude_token: document.getElementById('w-claude').value.trim(),
             model: document.getElementById('w-model').value.trim() || 'claude-opus-4-8',
             repos: []
           })});
         var out=await res.json();
         if(out.ok){ msg.textContent='✅ 已保存，正在进入 Inbox…'; setTimeout(function(){location.href='/inbox'},500); }
         else{ msg.textContent='❌ '+out.error; }
       }catch(e){ msg.textContent='❌ '+e; }
     }
     </script>`,
  );
}

/** Add/remove a watched repo from the Inbox page; saves settings and hot-applies. */
async function handleRepoMutation(
  store: Store,
  action: "add" | "remove",
  req: IncomingMessage,
  res: ServerResponse,
  onSettingsChanged?: (config: AppConfig) => void,
): Promise<void> {
  const stored = store.getSettingsRaw();
  if (!stored) {
    res.writeHead(302, { location: "/setup" });
    res.end();
    return;
  }
  const form = new URLSearchParams(await readBody(req));
  const url = (form.get("url") ?? "").trim();
  if (!url) {
    return send(res, 400, page("无效输入", `<p>仓库 URL 不能为空。</p><p><a href="/inbox">← 返回 Inbox</a></p>`));
  }

  const norm = (u: string): string =>
    u.replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
  const doc = stored as Record<string, any>;
  const current: any[] = Array.isArray(doc.repos) ? doc.repos : [];
  const repos =
    action === "add"
      ? current.some((r) => norm(String(r?.url ?? "")) === norm(url))
        ? current // already watched — saving again is a harmless no-op
        : [...current, { url, watch: ["issues", "pulls"], only_from_others: true, ignore_authors: [] }]
      : current.filter((r) => norm(String(r?.url ?? "")) !== norm(url));

  const parsed = parseSettings({ ...doc, repos });
  if (!parsed.ok) {
    return send(
      res,
      422,
      page("保存失败", `<h1>❌ 保存失败</h1><p>${esc(parsed.error)}</p><p><a href="/inbox">← 返回 Inbox</a></p>`),
    );
  }
  store.saveSettingsRaw(parsed.settings);
  // Hot-apply: the hook restarts the engine timer, which immediately runs a cycle —
  // a newly added repo shows up without waiting for the next interval.
  onSettingsChanged?.(parsed.config);
  console.log(`[settings] repo ${action}: ${url}`);
  res.writeHead(303, { location: "/inbox" });
  res.end();
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
    `<h1>设置</h1>
     <p class="meta">引擎状态：${engine.configured ? "🟢 运行中" : "⚪️ 未配置（保存后自动启动）"}</p>

     <h2>🔐 认证</h2>
     <div class="panel">
       <label class="field">GitHub Token（需要对所监控仓库的写权限）
         <input id="s-github" type="password" autocomplete="off" value="${v(raw.github_token, "")}"></label>
       <label class="field">Claude Token（可选。留空 = 使用本机 Claude Code 登录态；sk-ant-oat… 视为订阅 OAuth token，其他 sk-ant-… 视为 API Key）
         <input id="s-claude" type="password" autocomplete="off" value="${v(raw.claude_token, "")}"></label>
     </div>

     <h2>🧠 判定与轮询</h2>
     <div class="panel grid">
       <label class="field">判定模型
         <input id="s-model" type="text" value="${v(raw.model, "claude-opus-4-8")}"></label>
       <label class="field">轮询间隔（分钟）
         <input id="s-interval" type="number" min="1" value="${v(raw.poll_interval_minutes, "5")}"></label>
       <label class="field">首次回看天数
         <input id="s-lookback" type="number" min="1" value="${v(raw.lookback_days_on_first_run, "7")}"></label>
     </div>

     <h2>📦 仓库</h2>
     <div class="panel">
       <div id="repos">${repos.map(repoRow).join("")}</div>
       <button type="button" class="ghost" onclick="addRepo()">＋ 添加仓库</button>
       <template id="repo-tpl">${repoRow({})}</template>
     </div>

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
    { side: renderSidebar(store, { view: "settings" }) },
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

  const tag =
    p.itemType === "pull_request"
      ? `<span class="tag tag-pr">PR</span>`
      : `<span class="tag tag-issue">Issue</span>`;
  return `<div class="card">
    <div class="cardhead">${tag}<b>${esc(p.owner)}/${esc(p.repo)}</b><span>#${p.number}</span>
      <a class="ext" href="${esc(p.htmlUrl)}" target="_blank" rel="noopener">在 GitHub 打开 ↗</a></div>
    <div class="title">${esc(clip(p.title, 200))}</div>
    <div class="reasoning">🧠 ${esc(clip(d.reasoning, 600))} <span class="meta">（置信度 ${conf}%）</span></div>
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
      `<h1><span class="tag ${p.itemType === "pull_request" ? "tag-pr" : "tag-issue"}">${typeLabel}</span> ${esc(p.owner)}/${esc(p.repo)} #${p.number}</h1>
       <p class="meta"><a href="${esc(p.htmlUrl)}" target="_blank" rel="noopener">在 GitHub 打开 ↗</a> · <span class="chip st-${esc(p.status)}">${esc(STATUS_LABEL[p.status] ?? p.status)}</span></p>
       <h2>判断依据</h2><p>${esc(p.decision.reasoning)}</p>
       ${LANG_TABS}
       <div class="lang-zh"><h2>草稿回复（中文，仅供理解）</h2><pre>${esc(zh)}</pre></div>
       <div class="lang-en"><h2>Draft reply (English — this is what gets posted)</h2><pre>${esc(en)}</pre></div>`,
      { side: renderSidebar(store, { view: "open" }) },
    ),
  );
}

// ---- PR review page ----
function renderReviewPage(p: PendingDecision, side: string): string {
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
    `<h1><span class="tag tag-pr">PR</span> ${esc(p.owner)}/${esc(p.repo)} #${p.number}</h1>
     <p class="meta"><a href="${esc(p.htmlUrl)}" target="_blank" rel="noopener">在 GitHub 打开 ↗</a> · <span class="chip st-${esc(p.status)}">${esc(STATUS_LABEL[p.status] ?? p.status)}</span></p>
     <h2>🧠 判断依据（置信度 ${Math.round(d.confidence * 100)}%）</h2>
     <div class="panel">${esc(d.reasoning)}</div>
     ${inner}
     ${diffSection}`,
    { side, wide: true },
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
  opts?: {
    refreshSeconds?: number;
    /** prebuilt sidebar HTML (renderSidebar); omit for chromeless pages (wizard, errors) */
    side?: string;
    /** wider content column (the review page's diffs) */
    wide?: boolean;
  },
): string {
  return `<!doctype html><html lang="zh" data-lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts?.refreshSeconds ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">` : ""}
<title>${esc(title)}</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  :root{
    --bg:#f2f4f8;--surface:#fff;--surface2:#f5f7fa;--border:#e3e7ee;--border2:#edf0f5;
    --text:#141a22;--muted:#5f6b7a;--faint:#98a2b3;
    --accent:#2f6bff;--accent-bg:#ebf1ff;--ok:#1a7f37;--ok-bg:#e6f6ea;--danger:#c93a3a;
    --shadow:0 1px 2px rgba(20,30,50,.06),0 2px 6px rgba(20,30,50,.05);
    --shadow-lg:0 6px 20px rgba(20,30,50,.12);--r:12px;
  }
  @media(prefers-color-scheme:dark){:root{
    --bg:#0c0f14;--surface:#151a21;--surface2:#1b212b;--border:#2a3240;--border2:#222936;
    --text:#e4e9f0;--muted:#94a0b2;--faint:#6a7787;
    --accent:#5f8dff;--accent-bg:#1a2540;--ok:#41c463;--ok-bg:#15281c;--danger:#ee7b7b;
    --shadow:0 1px 2px rgba(0,0,0,.5);--shadow-lg:0 8px 24px rgba(0,0,0,.55);
  }}
  body{margin:0;background:var(--bg);color:var(--text);
    font:15px/1.65 -apple-system,"SF Pro Text",system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
  main{max-width:840px;margin:0 auto;padding:1.5rem 1.5rem 4rem}
  main.wide{max-width:1120px}
  body.withside main{margin:0 0 0 236px;max-width:1600px;padding:1.4rem 2.25rem 4rem}
  body.withside main.wide{max-width:none}
  a{color:var(--accent)}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px}

  /* sidebar (mail-client layout) */
  .side{position:fixed;top:0;bottom:0;left:0;width:236px;z-index:20;
    display:flex;flex-direction:column;background:var(--surface);
    border-right:1px solid var(--border);padding:.85rem .6rem .7rem;overflow-y:auto}
  .sbrand{font-weight:700;font-size:.95rem;letter-spacing:.01em;padding:.2rem .6rem .8rem}
  .snav{display:flex;flex-direction:column;gap:1px}
  .sgap{height:.9rem}
  .side a{display:flex;align-items:center;gap:.45rem;padding:.32rem .6rem;border-radius:8px;
    color:var(--muted);text-decoration:none;font-size:.88rem;font-weight:550;min-width:0}
  .side a .ic{width:1.2rem;text-align:center;flex:none}
  .side a .lbl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .side a.sub{padding-left:2.15rem;font-size:.83rem;font-weight:450}
  .side a:hover{background:var(--surface2);color:var(--text)}
  .side a.active{background:var(--accent-bg);color:var(--accent);font-weight:650}
  .scount{margin-left:auto;flex:none;font-size:.7rem;font-weight:700;
    background:var(--surface2);color:var(--faint);border-radius:99px;padding:.02rem .45rem}
  .scount.hot{background:var(--accent);color:#fff}
  .side a.active .scount{background:var(--accent);color:#fff}
  .sfoot{margin-top:auto;border-top:1px solid var(--border2);padding-top:.55rem;
    display:flex;flex-direction:column;gap:1px}
  @media(max-width:760px){.side{display:none}body.withside main{margin-left:0}}

  /* logs */
  .logbox{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
    box-shadow:var(--shadow);padding:.8rem 1rem;max-height:74vh;overflow:auto;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;line-height:1.55}
  .ll{white-space:pre-wrap;word-break:break-all}
  .ll.lw{color:#9a6700} .ll.le{color:var(--danger)}
  @media(prefers-color-scheme:dark){.ll.lw{color:#d29922}}
  li.hist .when{margin-left:auto;flex:none;font-size:.78rem}

  /* type & headings */
  h1{font-size:1.3rem;font-weight:700;letter-spacing:-.01em;margin:.5rem 0 1rem}
  h2{font-size:.78rem;font-weight:700;color:var(--muted);text-transform:uppercase;
    letter-spacing:.07em;margin:2rem 0 .7rem}
  .meta{color:var(--muted);font-size:.88rem}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;
    background:var(--surface2);border:1px solid var(--border2);padding:.08rem .35rem;border-radius:5px}
  pre{white-space:pre-wrap;word-wrap:break-word;background:var(--surface2);
    border:1px solid var(--border);border-radius:8px;padding:.8rem 1rem;font-size:.88rem}

  /* surfaces */
  .panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
    padding:1rem 1.25rem;box-shadow:var(--shadow)}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
    padding:1rem 1.25rem;margin:1rem 0;box-shadow:var(--shadow);transition:box-shadow .15s,transform .15s}
  .card:hover{box-shadow:var(--shadow-lg)}
  .cardhead{display:flex;align-items:center;gap:.5rem;font-size:.85rem;color:var(--muted);flex-wrap:wrap}
  .card .title{font-weight:650;font-size:1.02rem;margin:.35rem 0;line-height:1.45}
  .reasoning{background:var(--surface2);border-left:3px solid var(--accent);
    border-radius:0 8px 8px 0;padding:.55rem .8rem;margin:.65rem 0;font-size:.92rem}
  a.ext{margin-left:auto;font-size:.82rem;text-decoration:none;white-space:nowrap}
  a.ext:hover{text-decoration:underline}
  .empty{background:var(--surface);border:1px dashed var(--border);border-radius:var(--r);
    padding:2.4rem 1rem;text-align:center;color:var(--muted)}
  .empty .big{display:block;font-size:2.1rem;margin-bottom:.5rem}

  /* badges & chips */
  .tag{font-size:.72rem;font-weight:700;padding:.12rem .55rem;border-radius:99px;letter-spacing:.02em}
  .tag-pr{background:#efe7fd;color:#7d3fd6} .tag-issue{background:var(--ok-bg);color:var(--ok)}
  .count{font-size:.85rem;background:var(--accent);color:#fff;border-radius:99px;
    padding:.1rem .55rem;vertical-align:2px;margin-left:.2rem}
  .chip{font-size:.75rem;font-weight:600;padding:.08rem .55rem;border-radius:99px;
    background:var(--surface2);color:var(--muted);white-space:nowrap}
  .chip.st-replied,.chip.st-executed{background:var(--ok-bg);color:var(--ok)}
  .chip.st-superseded{background:#fdf3d0;color:#8a6a00}
  .sev{font-size:.72rem;font-weight:700;padding:.1rem .5rem;border-radius:99px;margin:0 .35rem}
  .sev-blocker{background:#fde3e3;color:#c02626} .sev-suggestion{background:#dcebff;color:#1d63d8}
  .sev-nit{background:var(--surface2);color:var(--muted)} .sev-question{background:#fdf3d0;color:#8a6a00}
  .warn{color:var(--danger);font-size:.8rem}

  /* buttons */
  button,a.btn{font:inherit;font-size:.88rem;font-weight:600;padding:.45rem 1.05rem;border:0;
    border-radius:8px;background:var(--accent);color:#fff;cursor:pointer;text-decoration:none;
    display:inline-flex;align-items:center;gap:.35rem;transition:filter .12s}
  button:hover,a.btn:hover{filter:brightness(1.09)}
  button.ghost{background:transparent;color:var(--muted);border:1px solid var(--border)}
  button.ghost:hover{background:var(--surface2);color:var(--text);filter:none}
  .actions{display:flex;gap:.6rem;align-items:center;margin-top:.8rem;flex-wrap:wrap}
  form.inline{display:inline;margin:0}

  /* forms */
  input[type=text],input[type=password],input[type=number],textarea{width:100%;font:inherit;
    padding:.5rem .7rem;border:1px solid var(--border);border-radius:8px;
    background:var(--surface);color:inherit;transition:border-color .12s,box-shadow .12s}
  input:focus,textarea:focus{outline:none;border-color:var(--accent);
    box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
  input[type=checkbox]{width:auto;accent-color:var(--accent)}
  textarea{background:var(--surface2)}
  label.field{display:block;margin:.85rem 0;font-size:.85rem;font-weight:550;color:var(--muted)}
  label.field input{margin-top:.35rem;font-weight:400}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:0 1.25rem}
  @media(max-width:640px){.grid{grid-template-columns:1fr}}

  /* repo rows (settings + inbox) */
  .repo{display:flex;gap:.5rem;align-items:center;margin:.5rem 0;flex-wrap:wrap}
  .repo input[type=text]{width:auto}
  .repo .r-url{flex:2;min-width:14rem} .repo .r-ignore{flex:1;min-width:8rem}
  .repo label{font-size:.85rem;color:var(--muted);white-space:nowrap}
  .addrepo{display:flex;gap:.6rem;align-items:center;margin:.7rem 0 .2rem}
  .addrepo input{flex:1;width:auto;min-width:10rem}
  .addrepo button{white-space:nowrap}

  /* lists */
  ul.histlist{list-style:none;padding:0;margin:0}
  li.hist{display:flex;align-items:center;gap:.55rem;padding:.5rem .1rem;font-size:.88rem;
    border-bottom:1px solid var(--border2);flex-wrap:wrap}
  li.hist:last-child{border-bottom:0}
  li.hist form.inline{margin-left:auto}
  li.hist form.inline button{font-size:.78rem;padding:.12rem .55rem}

  /* language tabs */
  .tabs{display:inline-flex;background:var(--surface2);border:1px solid var(--border);
    border-radius:9px;padding:2px;gap:2px;margin:1rem 0}
  .tabs button{background:transparent;color:var(--muted);border-radius:7px;
    padding:.22rem .95rem;font-size:.84rem;box-shadow:none}
  .tabs button:hover{filter:none;color:var(--text)}
  .tabs button.active{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
  [data-lang="zh"] .lang-en{display:none}
  [data-lang="en"] .lang-zh{display:none}
  .en{margin:.3rem 0;font-size:.9rem;color:var(--muted);border-left:3px solid var(--border);padding-left:.6rem}

  /* review points & diffs */
  ul.pts{list-style:none;padding:0}
  li.pt{background:var(--surface);border:1px solid var(--border);border-radius:10px;
    padding:.8rem 1rem;margin:.7rem 0;box-shadow:var(--shadow)}
  li.pt label{cursor:pointer} .cmt{margin:.4rem 0} .ev{color:var(--muted);font-size:.88rem}
  pre.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem;padding:.5rem;line-height:1.5}
  pre.code .hl{background:#fff3bf}
  details{background:var(--surface);border:1px solid var(--border);border-radius:10px;margin:.6rem 0;box-shadow:var(--shadow)}
  details>summary{cursor:pointer;padding:.55rem .9rem;font-family:ui-monospace,Menlo,monospace;
    font-size:.84rem;color:var(--muted);border-radius:10px}
  details[open]>summary{border-bottom:1px solid var(--border);color:var(--text)}
  details>summary:hover{color:var(--text)}
  details pre.code{margin:0;border:0;border-radius:0 0 10px 10px;max-height:70vh;overflow:auto;background:var(--surface)}
  .da{background:#e9f8ee} .dd{background:#fdecec} .dh{color:#8250df;padding:.15rem 0}

  /* setup wizard */
  .wizard{max-width:560px;margin:2.5rem auto 0}
  .wizard h1{margin:.4rem 0 .3rem}
  .whead{text-align:center;margin-bottom:1.6rem}
  .whead .logo{font-size:2.4rem;display:block}
  .steps{display:flex;align-items:center;gap:.7rem;margin:1.4rem 0;font-size:.86rem;font-weight:600}
  .step{display:inline-flex;align-items:center;gap:.5rem;color:var(--faint)}
  .step .dot{width:1.55rem;height:1.55rem;border-radius:50%;display:inline-flex;align-items:center;
    justify-content:center;background:var(--surface2);border:1px solid var(--border);font-size:.78rem}
  .step.on{color:var(--text)}
  .step.on .dot{background:var(--accent);border-color:var(--accent);color:#fff}
  .step.done{color:var(--ok)}
  .step.done .dot{background:var(--ok-bg);border-color:transparent;color:var(--ok)}
  .steps .line{flex:1;height:1px;background:var(--border)}
  .wizard .panel{padding:1.25rem 1.5rem}

  @media(prefers-color-scheme:dark){
    .tag-pr{background:#2c2150;color:#c4a5ff}
    .chip.st-superseded,.sev-question{background:#3a2e08;color:#e3b341}
    .sev-blocker{background:#3a1a18;color:#f47067} .sev-suggestion{background:#182236;color:#79a8ff}
    pre.code .hl{background:#3f2e00}
    .da{background:#12261e} .dd{background:#2b1719} .dh{color:#a371f7}
  }
</style></head><body${opts?.side ? ' class="withside"' : ""}>${opts?.side ?? ""}<main${opts?.wide ? ' class="wide"' : ""}>${inner}</main>
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
