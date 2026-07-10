import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { recentLogs } from "./log.ts";
import type { Store, PendingDecision, ArchiveItem } from "./store.ts";
import type { TriageEngine } from "./engine.ts";
import type { SuggestedAction } from "./judge/schema.ts";
import type { RepoAnalysis, RepoComponent, RepoFinding } from "./judge/repo-analysis.ts";
import { parseSettings, type AppConfig } from "./config.ts";
import { parsePatch, commentableLines, type DiffLine } from "./diff.ts";
import { mdToHtml, clipMd } from "./md.ts";
import { submitPrReview, type InlineComment } from "./github/actions.ts";

// ---- interface language (设置里可切换中/英) ----
// Set per request from settings; rendering is synchronous, so module state is safe.
type UiLang = "zh" | "en";
let UI: UiLang = "zh";
/** Content languages: display = what the judge writes for the human, post = what gets posted. */
let LANGS = { display: "中文", post: "English" };

function applyUiPrefs(store: Store): void {
  const raw = (store.getSettingsRaw() ?? {}) as Record<string, any>;
  UI = raw.ui_language === "en" ? "en" : "zh";
  const pick = (v: unknown, d: string): string =>
    typeof v === "string" && v.trim() ? v.trim() : d;
  LANGS = { display: pick(raw.display_language, "中文"), post: pick(raw.post_language, "English") };
}

/** zh string → en string; anything unlisted falls back to the zh text. */
const EN: Record<string, string> = {
  "待处理": "Pending",
  "已处理": "Done",
  "设置": "Settings",
  "日志": "Logs",
  "预览": "Preview",
  "发布": "Outgoing",
  "没有待处理的卡片": "No pending cards",
  "轮询每隔几分钟运行一次，新的判定会自动出现在这里": "Polling runs every few minutes — new judgments show up here automatically",
  "还没有监控任何仓库": "No repositories watched yet",
  "到<a href=\"/settings\">设置</a>里添加一个 GitHub 仓库，轮询就会开始": "Add a GitHub repository in <a href=\"/settings\">Settings</a> to start polling",
  "还没有已处理的记录": "No archived cards yet",
  "回复 / 执行 / 忽略过的卡片会归档到这里": "Replied / executed / ignored cards are archived here",
  "在 GitHub 打开": "Open on GitHub",
  "置信度": "confidence",
  "草稿回复（点开审阅/编辑）": "Draft reply (open to review / edit)",
  "批准并回复": "Approve & reply",
  "忽略": "Ignore",
  "恢复": "Restore",
  "建议动作": "Suggested action",
  "执行": "Execute",
  "逐条审核并提交": "Review points & submit",
  "无动作": "No action",
  "关闭 issue": "Close issue",
  "批准 PR": "Approve PR",
  "要求修改 PR": "Request changes",
  "关闭 PR": "Close PR",
  "打标签": "Add labels",
  "已回复": "Replied",
  "已执行": "Executed",
  "已忽略": "Ignored",
  "已被取代": "Superseded",
  "运行日志": "Runtime logs",
  "（暂无日志输出）": "(no log output yet)",
  "判断依据": "Rationale",
  "总体意见": "Overall comment",
  "逐条审查意见（勾选采纳，未勾选不提交）": "Per-point comments (checked = adopt; unchecked are not submitted)",
  "逐条审查意见": "Per-point comments",
  "提交采纳项到 GitHub": "Submit selected to GitHub",
  "改动 diff（按文件折叠）": "Diff (collapsed per file)",
  "有审查意见": "has review points",
  "（无法定位到改动行，将进 review 正文）": "(cannot anchor to a changed line — goes into the review body)",
  "依据：": "Evidence: ",
  "（无逐行意见，提交后仅发送总体意见正文）": "(no per-line points; only the overall body will be posted)",
  "引擎状态：": "Engine status: ",
  "运行中": "Running",
  "未配置（保存后自动启动）": "Not configured (starts after saving)",
  "认证": "Authentication",
  "GitHub Token（需要对所监控仓库的写权限）": "GitHub token (needs write access to the watched repos)",
  "Claude Token（可选。留空 = 使用本机 Claude Code 登录态；sk-ant-oat… 视为订阅 OAuth token，其他 sk-ant-… 视为 API Key）":
    "Claude token (optional; empty = this machine's Claude Code login; sk-ant-oat… = subscription OAuth token, other sk-ant-… = API key)",
  "判定与轮询": "Judging & polling",
  "判定模型": "Judge model",
  "轮询间隔（分钟）": "Poll interval (minutes)",
  "语言": "Language",
  "界面语言": "Interface language",
  "展示语言（判定内容给你看的语言：判断依据、草稿预览）": "Display language (what the judge writes for you: rationale, draft previews)",
  "发布语言（回复和 Review 实际发布到 GitHub 使用的语言）": "Posting language (used for replies and reviews actually posted to GitHub)",
  "仓库": "Repositories",
  "添加仓库": "Add repository",
  "仅他人": "Others only",
  "忽略作者,逗号分隔": "ignored authors, comma-separated",
  "只处理非维护者发起的条目": "Only handle items opened by non-maintainers",
  "停止监控该仓库": "Stop watching this repository",
  "移除该仓库": "Remove this repository",
  "保存并应用": "Save & apply",
  "无权访问": "Access denied",
  "缺少或错误的访问令牌。请从应用窗口打开本页面。": "Missing or invalid access token. Open this page from the app window.",
  "链接无效或缺少 token。": "Invalid link or missing token.",
  "未找到": "Not found",
  "出错了": "Error",
  "卡片不存在。": "Card not found.",
  "token 不匹配。": "Token mismatch.",
  "操作失败": "Action failed",
  "卡片状态未变，可回到 Inbox 重试。": "The card is unchanged — go back to the Inbox and retry.",
  "← 返回 Inbox": "← Back to Inbox",
  "该草稿不存在或已过期。": "This draft does not exist or has expired.",
  "已处理过": "Already handled",
  "该 PR 已处理过。": "This PR was already handled.",
  "无内容": "Nothing to submit",
  "没有勾选任何意见，也没有总体正文，未提交。": "No points selected and no overall body — nothing was submitted.",
  "提交失败": "Submission failed",
  "提交到 GitHub 失败": "Failed to submit to GitHub",
  "已提交": "Submitted",
  "已提交 PR Review": "PR review submitted",
  "确定要将这条回复发布到 GitHub 吗？": "Post this reply to GitHub?",
  "生成分析": "Generate analysis",
  "重新生成分析": "Regenerate analysis",
  "分析进行中…": "Analyzing…",
  "尚未生成分析": "No analysis yet",
  "由 AI 阅读整个仓库的代码，产出系统架构与安全漏洞扫描（只读，不会执行仓库代码）":
    "AI reads the whole repository and produces an architecture overview plus a security scan (read-only; the repo's code is never executed)",
  "分析进行中，AI 正在阅读代码…": "Analysis in progress — AI is reading the code…",
  "页面会自动刷新，通常需要几分钟": "This page refreshes automatically; a run typically takes a few minutes",
  "分析失败": "Analysis failed",
  "系统架构": "Architecture",
  "安全漏洞扫描": "Security scan",
  "未发现明显安全问题": "No obvious security issues found",
  "更新于": "Updated",
  "引擎未配置，请先在设置页完成配置。": "The engine is not configured yet — finish setup on the settings page first.",
  "历史": "History",
  "已合并": "Merged",
  "已关闭": "Closed",
  "开放": "Open",
  "上一页": "Prev",
  "下一页": "Next",
  "创建于": "Created",
  "关闭于": "Closed",
  "评论时间线": "Timeline",
  "（没有评论）": "(no comments)",
  "该条目尚未同步到本地档案": "This item is not in the local archive yet",
  "历史会在轮询周期后自动回填，也可在仓库页手动同步": "History backfills automatically after poll cycles; you can also sync manually on the repo page",
  "历史档案": "History archive",
  "条已关闭的 issue/PR": "closed issues/PRs stored",
  "同步历史": "Sync history",
  "同步中…": "Syncing…",
  "同步中断，将自动续跑": "Sync interrupted — will resume automatically",
  "查看完整历史": "Full history",
  "作者": "OP",
  "确定要将勾选的审查意见提交到 GitHub 吗？": "Submit the selected review points to GitHub?",
  "在 GitHub 查看这次 review": "View this review on GitHub",
  "状态": "status",
  "无效的 JSON": "Invalid JSON",
};
const t = (s: string): string => (UI === "en" ? (EN[s] ?? s) : s);

/** e.g. （置信度 92%） / (confidence 92%) */
function confLabel(conf: number): string {
  return UI === "en" ? `(confidence ${conf}%)` : `（置信度 ${conf}%）`;
}
/** Qualifier line above the display-language (preview) block. */
function previewLabel(): string {
  return UI === "en"
    ? `Preview (${LANGS.display} — for your reference, never posted)`
    : `预览（${LANGS.display}，仅供理解，不会发布）`;
}
const isZhName = (name: string): boolean => name.trim() === "中文";
function pickPair(primary?: string | null, fallback?: string | null): string {
  return primary?.trim() ? primary : fallback?.trim() ? fallback : "";
}
/** The display-language variant of a stored zh/en text pair (falls back to the other). */
function displayText(zh?: string | null, en?: string | null): string {
  return isZhName(LANGS.display) ? pickPair(zh, en) : pickPair(en, zh);
}
/** The posting-language variant of a stored zh/en text pair (falls back to the other). */
function postText(zh?: string | null, en?: string | null): string {
  return isZhName(LANGS.post) ? pickPair(zh, en) : pickPair(en, zh);
}

/** Qualifier line above the post-language (outgoing) block. */
function outgoingLabel(editable = false): string {
  return UI === "en"
    ? `Outgoing (${LANGS.post} — posted to GitHub${editable ? ", editable" : ""})`
    : `发布（${LANGS.post}，实际发布到 GitHub${editable ? "，可编辑" : ""}）`;
}

const REPLY_RE = /^\/reply\/([A-Za-z0-9_-]+)\/?$/;
const REVIEW_RE = /^\/review\/([A-Za-z0-9_-]+)\/?$/;
const CARD_ACTION_RE = /^\/card\/([A-Za-z0-9_-]+)\/(reply|act|ignore|restore)\/?$/;
const REPO_PAGE_RE = /^\/repo\/([^/]+)\/([^/]+)\/?$/;
const REPO_ANALYZE_RE = /^\/repo\/([^/]+)\/([^/]+)\/analyze\/?$/;
const REPO_SYNC_RE = /^\/repo\/([^/]+)\/([^/]+)\/sync\/?$/;
const ITEM_RE = /^\/item\/([^/]+)\/([^/]+)\/(\d+)\/?$/;

/**
 * Local HTTP service that IS the app UI (the desktop shell loads these pages).
 * Mail-client layout: a fixed sidebar (待处理/已处理 folders grouped by repo,
 * 设置/日志 at the bottom) next to the content column.
 *  - GET  /                    → /inbox
 *  - GET  /setup               first-run wizard: step 1 model, step 2 GitHub (no repos)
 *  - GET  /inbox?view=open|done&repo=owner/repo   folder views
 *  - GET  /logs                recent runtime log lines (in-memory ring buffer)
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
      applyUiPrefs(store); // interface + content languages for everything rendered below

      // UI session gate: accept the token via ?auth=… once, then via cookie.
      const cookieOk = (req.headers.cookie ?? "")
        .split(/;\s*/)
        .includes(`ui=${uiToken}`);
      const queryOk = url.searchParams.get("auth") === uiToken;
      if (!cookieOk && !queryOk) {
        return send(res, 403, page(t("无权访问"), `<p>${t("缺少或错误的访问令牌。请从应用窗口打开本页面。")}</p>`));
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
        const pageNum = Math.max(1, parseInt(url.searchParams.get("p") ?? "1", 10) || 1);
        return send(res, 200, renderInbox(store, view, repoFilter, pageNum));
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

      const analyze = path.match(REPO_ANALYZE_RE);
      if (req.method === "POST" && analyze) {
        const owner = decodeURIComponent(analyze[1]);
        const repo = decodeURIComponent(analyze[2]);
        if (!engine.configured) {
          return send(res, 409, page(t("出错了"), `<p>${t("引擎未配置，请先在设置页完成配置。")}</p>`));
        }
        // Fire-and-forget: status lives in store.repo_analysis, the page polls it.
        engine.runRepoAnalysis(owner, repo).catch(() => {});
        res.writeHead(303, {
          location: `/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        });
        return res.end();
      }

      const sync = path.match(REPO_SYNC_RE);
      if (req.method === "POST" && sync) {
        const owner = decodeURIComponent(sync[1]);
        const repo = decodeURIComponent(sync[2]);
        if (!engine.configured) {
          return send(res, 409, page(t("出错了"), `<p>${t("引擎未配置，请先在设置页完成配置。")}</p>`));
        }
        engine.runArchiveSync(owner, repo).catch(() => {});
        res.writeHead(303, {
          location: `/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        });
        return res.end();
      }

      const repoPage = path.match(REPO_PAGE_RE);
      if (req.method === "GET" && repoPage) {
        return send(
          res,
          200,
          renderRepoPage(store, decodeURIComponent(repoPage[1]), decodeURIComponent(repoPage[2])),
        );
      }

      const itemPage = path.match(ITEM_RE);
      if (req.method === "GET" && itemPage) {
        return send(
          res,
          200,
          renderItemPage(
            store,
            decodeURIComponent(itemPage[1]),
            decodeURIComponent(itemPage[2]),
            parseInt(itemPage[3], 10),
          ),
        );
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
          return send(res, 403, page(t("无权访问"), `<p>${t("链接无效或缺少 token。")}</p>`));
        }
        if (req.method === "GET")
          return send(res, 200, renderReviewPage(p, renderSidebar(store, { view: "open" })));
        if (req.method === "POST")
          return handleSubmit(engine, p, req, res);
      }

      send(res, 404, page(t("未找到"), "<p>Not found</p>"));
    } catch (err) {
      console.error("[http] handler error:", (err as Error).message);
      send(res, 500, page(t("出错了"), "<p>Internal error</p>"));
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
  active: { view: "open" | "done" | "settings" | "logs" | "repo"; repo?: string },
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

  const folder = (view: "open" | "done", iconHtml: string, label: string, total: number): string => {
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
    const head = item(`/inbox?view=${view}`, label, {
      icon: iconHtml,
      count: total,
      hot: view === "open" && total > 0,
      on: active.view === view && !active.repo,
    });
    // Collapsible: the chevron toggles .closed (persisted per folder in
    // localStorage by the page script); the header link still navigates.
    return `<div class="sfolder" data-fold="${view}">
      <div class="fhead">${head}<button class="fold" aria-label="toggle">${icon("chev", 13)}</button></div>
      <div class="fkids">${rows}</div>
    </div>`;
  };

  // Per-repo analysis pages (architecture map + security scan).
  const repoLinks = keys
    .map((k) => {
      const [o, r] = k.split("/");
      return item(`/repo/${encodeURIComponent(o)}/${encodeURIComponent(r)}`, k, {
        icon: icon("repo"),
        on: active.view === "repo" && active.repo === k,
      });
    })
    .join("");
  const repoSection = keys.length
    ? `<div class="sgap"></div><div class="shead">${t("仓库")}</div>${repoLinks}`
    : "";

  return `<aside class="side">
    <div class="sbrand"><span class="mark">${icon("pr", 15)}</span>GitTriage</div>
    <nav class="snav">
      ${folder("open", icon("inbox"), t("待处理"), totalOpen)}
      <div class="sgap"></div>
      ${folder("done", icon("done"), t("已处理"), totalDone)}
      ${repoSection}
    </nav>
    <div class="sfoot">
      ${item("/settings", t("设置"), { icon: icon("gear"), on: active.view === "settings" })}
      ${item("/logs", t("日志"), { icon: icon("logs"), on: active.view === "logs" })}
    </div>
  </aside>`;
}

const DONE_PAGE_SIZE = 50;

function renderInbox(
  store: Store,
  view: "open" | "done",
  repoFilter?: string,
  pageNum = 1,
): string {
  const side = renderSidebar(store, { view, repo: repoFilter });
  const inRepo = (p: PendingDecision): boolean =>
    !repoFilter || `${p.owner}/${p.repo}` === repoFilter;
  const suffix = repoFilter ? ` · ${esc(repoFilter)}` : "";

  if (view === "done") {
    // The done folder = cards you handled + the repo's closed issue/PR history
    // (synced local archive), merged newest-first.
    const cardRows = store.listDone(500).filter(inRepo).map((p) => ({
      ts: p.createdAt,
      html: renderDoneCardRow(p),
    }));
    const archRows = store.listClosedArchive(repoFilter, 500).map((it) => ({
      ts: Date.parse(it.ghClosedAt ?? it.ghUpdatedAt) || 0,
      html: renderArchiveRow(it),
    }));
    const all = [...cardRows, ...archRows].sort((a, b) => b.ts - a.ts);
    const pages = Math.max(1, Math.ceil(all.length / DONE_PAGE_SIZE));
    const cur = Math.min(pageNum, pages);
    const rows = all
      .slice((cur - 1) * DONE_PAGE_SIZE, cur * DONE_PAGE_SIZE)
      .map((r) => r.html)
      .join("");
    const pageUrl = (p: number): string =>
      `/inbox?view=done${repoFilter ? `&repo=${encodeURIComponent(repoFilter)}` : ""}&p=${p}`;
    const pager =
      pages > 1
        ? `<div class="pager">
            ${cur > 1 ? `<a href="${pageUrl(cur - 1)}">‹ ${t("上一页")}</a>` : ""}
            <span class="meta">${cur} / ${pages}</span>
            ${cur < pages ? `<a href="${pageUrl(cur + 1)}">${t("下一页")} ›</a>` : ""}
          </div>`
        : "";
    return page(
      `${t("已处理")}${repoFilter ? ` · ${repoFilter}` : ""}`,
      `<h1>${t("已处理")}${suffix}${all.length ? `<span class="count">${all.length}</span>` : ""}</h1>
       ${rows
         ? `<div class="panel"><ul class="histlist">${rows}</ul></div>${pager}`
         : `<div class="empty"><span class="big">${icon("done", 36)}</span>${t("还没有已处理的记录")}${suffix ? "" : `<br><span class="meta">${t("回复 / 执行 / 忽略过的卡片会归档到这里")}</span>`}</div>`}`,
      { refreshSeconds: 60, side },
    );
  }

  const open = store.listOpen().filter(inRepo);
  const cards = open.map((p) => renderInboxCard(store, p)).join("");


  // Repo management lives on the settings page; the inbox only shows cards.
  const emptyState = watchedRepoKeys(store).length
    ? `<div class="empty"><span class="big">${icon("inbox", 36)}</span>${t("没有待处理的卡片")}<br><span class="meta">${t("轮询每隔几分钟运行一次，新的判定会自动出现在这里")}</span></div>`
    : `<div class="empty"><span class="big">${icon("repo", 36)}</span>${t("还没有监控任何仓库")}<br><span class="meta">${t('到<a href="/settings">设置</a>里添加一个 GitHub 仓库，轮询就会开始')}</span></div>`;

  return page(
    `${t("待处理")}${repoFilter ? ` · ${repoFilter}` : ""}${open.length ? ` (${open.length})` : ""}`,
    `<h1>${t("待处理")}${suffix}${open.length ? `<span class="count">${open.length}</span>` : ""}</h1>
     ${cards || emptyState}`,
    { refreshSeconds: 60, side },
  );
}

/** A handled card in the done list (your action + restore for ignored ones). */
function renderDoneCardRow(p: PendingDecision): string {
  const typeLabel = p.itemType === "pull_request" ? "PR" : "Issue";
  // Ignored cards can be sent back to the inbox; replied/executed already
  // wrote to GitHub and superseded ones have a newer card, so no undo there.
  const restoreForm =
    p.status === "ignored"
      ? `<form method="post" action="/card/${p.id}/restore" class="inline">
           <input type="hidden" name="token" value="${esc(p.token)}">
           <button class="ghost">${icon("undo", 12)} ${t("恢复")}</button></form>`
      : "";
  return `<li class="hist"><span class="chip st-${esc(p.status)}">${esc(t(STATUS_LABEL[p.status] ?? p.status))}</span>
    <span class="tag ${p.itemType === "pull_request" ? "tag-pr" : "tag-issue"}">${typeLabel}</span>
    <a href="/item/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/${p.number}">${esc(p.owner)}/${esc(p.repo)} #${p.number}</a>
    <span class="meta lbl">${esc(clip(p.title, 90))}</span>
    <span class="meta when">${esc(fmtWhen(p.createdAt))}</span>${restoreForm}</li>`;
}

/** A closed issue/PR from the local history archive. */
function renderArchiveRow(it: ArchiveItem): string {
  const [owner, repo] = it.repoKey.split("/");
  const typeLabel = it.itemType === "pull_request" ? "PR" : "Issue";
  const stateChip = it.merged
    ? `<span class="chip st-merged">${t("已合并")}</span>`
    : `<span class="chip st-closed">${t("已关闭")}</span>`;
  const when = it.ghClosedAt ? fmtWhen(Date.parse(it.ghClosedAt)) : "";
  return `<li class="hist">${stateChip}
    <span class="tag ${it.itemType === "pull_request" ? "tag-pr" : "tag-issue"}">${typeLabel}</span>
    <a href="/item/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${it.number}">${esc(it.repoKey)} #${it.number}</a>
    <span class="meta lbl">${esc(clip(it.title, 90))}</span>
    ${it.commentCount ? `<span class="meta">${icon("msg", 12)} ${it.commentCount}</span>` : ""}
    <span class="meta when">${esc(when)}</span></li>`;
}

// ---- archived item detail page (metadata + conversation timeline) ----

function renderItemPage(store: Store, owner: string, repo: string, number: number): string {
  const key = `${owner}/${repo}`;
  const side = renderSidebar(store, { view: "done", repo: key });
  const it =
    store.getArchiveItem(key, "issue", number) ??
    store.getArchiveItem(key, "pull_request", number);

  if (!it) {
    return page(
      `${key} #${number}`,
      `<h1>${esc(key)} #${number}</h1>
       <div class="empty"><span class="big">${icon("clock", 36)}</span>${t("该条目尚未同步到本地档案")}<br>
       <span class="meta">${t("历史会在轮询周期后自动回填，也可在仓库页手动同步")}</span></div>`,
      { side },
    );
  }

  const typeLabel = it.itemType === "pull_request" ? "PR" : "Issue";
  const stateChip = it.merged
    ? `<span class="chip st-merged">${t("已合并")}</span>`
    : it.state === "closed"
      ? `<span class="chip st-closed">${t("已关闭")}</span>`
      : `<span class="chip st-open">${t("开放")}</span>`;
  const labels = it.labels.length
    ? `<span class="meta">${icon("tag", 12)} ${esc(it.labels.join(", "))}</span>`
    : "";
  const dates =
    `<span class="meta">${t("创建于")} ${esc(fmtWhen(Date.parse(it.ghCreatedAt)))}` +
    (it.ghClosedAt ? ` · ${t("关闭于")} ${esc(fmtWhen(Date.parse(it.ghClosedAt)))}` : "") +
    `</span>`;

  const entryLi = (e: { kind: string; author: string; createdAt: string; body: string; reviewState?: string }): string =>
    `<li class="${userColorClass(e.author)}">
      ${tlHead(e.author, it.author, e, e.createdAt)}
      ${e.body.trim() ? `<div class="tlbody md">${mdToHtml(e.body)}</div>` : ""}</li>`;

  const timeline = it.timeline.length
    ? `<h2>${t("评论时间线")} (${it.timeline.length})</h2><ul class="tl">${it.timeline.map(entryLi).join("")}</ul>`
    : `<p class="meta">${t("（没有评论）")}</p>`;

  return page(
    `${key} #${number}`,
    `<div class="cardhead">${stateChip}
       <span class="tag ${it.itemType === "pull_request" ? "tag-pr" : "tag-issue"}">${typeLabel}</span>
       <b>${esc(key)}</b><span>#${it.number}</span>
       <a class="ext" href="${esc(it.htmlUrl)}" target="_blank" rel="noopener">${t("在 GitHub 打开")} ${icon("ext", 12)}</a></div>
     <h1>${esc(it.title)}</h1>
     <p class="meta">${esc(it.author)} · ${dates} ${labels}</p>
     ${it.body.trim() ? `<div class="panel"><div class="tlbody md">${mdToHtml(it.body)}</div></div>` : ""}
     ${timeline}`,
    { side },
  );
}

// ---- per-repo analysis page (architecture map + security scan) ----

const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEV_ZH: Record<string, string> = { critical: "严重", high: "高危", medium: "中危", low: "低危" };

/** Legacy analyses were stored before the commit fields existed. */
type StoredAnalysis = RepoAnalysis & { commitSha?: string; commitTimeMs?: number };

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderRepoPage(store: Store, owner: string, repo: string): string {
  const key = `${owner}/${repo}`;
  const side = renderSidebar(store, { view: "repo", repo: key });
  const rec = store.getRepoAnalysis(key);
  const running = rec?.status === "running";
  const analyzeUrl = `/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/analyze`;
  const btn = running
    ? `<button disabled>${icon("clock", 14)} ${t("分析进行中…")}</button>`
    : `<form method="post" action="${analyzeUrl}" class="inline"><button>${icon("spark", 14)} ${
        rec ? t("重新生成分析") : t("生成分析")
      }</button></form>`;
  const when =
    rec && !running
      ? `<span class="meta">${t("更新于")} ${fmtWhen(rec.updatedAt)}</span>`
      : "";

  // Local history archive: closed count + sync status/trigger.
  const syncState = store.getArchiveSync(key);
  const syncRunning = syncState?.status === "running";
  const closedCount = store.countClosedArchive(key);
  const syncUrl = `/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/sync`;
  const syncBtn = syncRunning
    ? `<button disabled class="ghost">${icon("clock", 13)} ${t("同步中…")}（${syncState?.synced ?? 0}）</button>`
    : `<form method="post" action="${syncUrl}" class="inline"><button class="ghost">${icon("undo", 13)} ${t("同步历史")}</button></form>`;
  const syncErr =
    syncState?.status === "error"
      ? `<span class="warn">${t("同步中断，将自动续跑")}：${esc(clip(syncState.error ?? "", 100))}</span>`
      : "";
  const archiveLine = `<div class="archline"><span class="meta">${t("历史档案")}：${closedCount} ${t("条已关闭的 issue/PR")}</span>${syncBtn}${syncErr}</div>`;

  let body: string;
  let commitChip = "";
  if (!rec) {
    body = `<div class="empty"><span class="big">${icon("repo", 36)}</span>${t("尚未生成分析")}<br>
      <span class="meta">${t("由 AI 阅读整个仓库的代码，产出系统架构与安全漏洞扫描（只读，不会执行仓库代码）")}</span></div>`;
  } else if (running) {
    body = `<div class="empty"><span class="big">${icon("clock", 36)}</span>${t("分析进行中，AI 正在阅读代码…")}<br>
      <span class="meta">${t("页面会自动刷新，通常需要几分钟")}</span></div>`;
  } else if (rec.status === "error") {
    body = `<div class="panel"><p class="warn">${t("分析失败")}：${esc(rec.error ?? "")}</p></div>`;
  } else {
    let a: StoredAnalysis | null = null;
    try {
      a = JSON.parse(rec.json ?? "") as StoredAnalysis;
    } catch {
      /* fall through to the error panel below */
    }
    if (!a) {
      body = `<div class="panel"><p class="warn">${t("分析失败")}：invalid stored JSON</p></div>`;
    } else {
      body = renderAnalysis(a);
      if (a.commitSha) {
        // Which code was analyzed: head SHA (links to GitHub) + its commit time.
        commitChip = `<span class="meta">commit
          <a href="https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commit/${esc(a.commitSha)}"
             target="_blank" rel="noopener"><code>${esc(a.commitSha.slice(0, 7))}</code></a>${
               a.commitTimeMs ? `（${fmtWhen(a.commitTimeMs)}）` : ""
             }</span>`;
      }
    }
  }

  return page(
    key,
    `<div class="repohead"><h1>${esc(key)}</h1>${btn}${when}${commitChip}</div>${archiveLine}${body}`,
    { side, wide: true, refreshSeconds: running || syncRunning ? 8 : undefined },
  );
}

function renderAnalysis(a: StoredAnalysis): string {

  // Architecture: components grouped into layers, dependencies as chips.
  const groups = new Map<string, RepoComponent[]>();
  for (const c of a.components) {
    const g = displayText(c.groupZh, c.group) || c.group;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(c);
  }
  const compBox = (c: RepoComponent): string =>
    `<div class="comp"><div class="cname">${esc(c.name)}</div>
      <div class="cpath">${esc(c.path)}</div>
      <div class="crole">${esc(displayText(c.roleZh, c.role))}</div>
      ${
        c.dependsOn.length
          ? `<div class="cdeps"><span class="arr">→</span>${c.dependsOn.map((d) => `<span class="dep">${esc(d)}</span>`).join("")}</div>`
          : ""
      }</div>`;
  const archRows = [...groups]
    .map(
      ([g, comps]) =>
        `<div class="archrow"><div class="archlabel">${esc(g)}</div>
         <div class="architems">${comps.map(compBox).join("")}</div></div>`,
    )
    .join(`<div class="archsep">${icon("chev", 14)}</div>`);

  // Security findings, most severe first.
  const findings = [...a.findings].sort(
    (x, y) => (SEV_ORDER[x.severity] ?? 9) - (SEV_ORDER[y.severity] ?? 9),
  );
  const findingLi = (f: RepoFinding): string =>
    `<li class="finding"><div class="fhead2">
       <span class="sev sev-${esc(f.severity)}">${esc(UI === "en" ? f.severity : (SEV_ZH[f.severity] ?? f.severity))}</span>
       <b>${esc(displayText(f.titleZh, f.title))}</b>
       ${f.file ? `<code>${esc(f.file)}${f.line ? `:${f.line}` : ""}</code>` : ""}
     </div>
     <div class="fdetail">${esc(displayText(f.detailZh, f.detail))}</div>
     ${
       pickPair(f.suggestionZh, f.suggestion) || pickPair(f.suggestion, f.suggestionZh)
         ? `<div class="fsug">${icon("wrench", 13)} ${esc(displayText(f.suggestionZh, f.suggestion))}</div>`
         : ""
     }</li>`;
  const security = findings.length
    ? `<ul class="findings">${findings.map(findingLi).join("")}</ul>`
    : `<div class="empty"><span class="big">${icon("done", 36)}</span>${t("未发现明显安全问题")}</div>`;

  // Two tabs; security scan is the default view.
  return `<div class="rviews" data-rview="sec">
    <div class="tabs rtabs">
      <button data-v="sec" class="active" onclick="setRepoView('sec')">${t("安全漏洞扫描")}${findings.length ? ` (${findings.length})` : ""}</button>
      <button data-v="arch" onclick="setRepoView('arch')">${t("系统架构")}</button>
    </div>
    <div class="rv rv-sec">${security}</div>
    <div class="rv rv-arch">
      <div class="panel"><p class="archoverview">${esc(displayText(a.overviewZh, a.overview))}</p>
      <div class="archmap">${archRows}</div></div>
    </div>
  </div>`;
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
  const metaLine = UI === "en"
    ? `Last ${lines.length} lines since process start (up to 1000 kept in memory, cleared on restart) · auto-refreshes every 15s`
    : `进程启动以来的最近 ${lines.length} 行（内存保留上限 1000 行，重启后清空）· 每 15 秒自动刷新`;
  return page(
    t("运行日志"),
    `<h1>${t("运行日志")}</h1>
     <p class="meta">${metaLine}</p>
     <div class="logbox" id="logbox">${rows || `<div class="ll meta">${t("（暂无日志输出）")}</div>`}</div>
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
       <span class="logo mark">${icon("pr", 26)}</span>
       <h1>欢迎使用 GitTriage</h1>
       <p class="meta">两步完成初始设置。仓库不在这里添加 —— 完成后在「设置」里随时添加。</p>
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
       msg.textContent='${UI === "en" ? "Saving…" : "保存中…"}';
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

/**
 * 中文/English dropdown for the content languages. The stored value feeds the judge
 * prompt verbatim; a legacy/custom value (anything else) is kept as an extra option
 * instead of being silently replaced.
 */
function langSelect(id: string, current: string): string {
  const cur = current.trim() || "中文";
  const std = ["中文", "English"];
  const extra = std.includes(cur) ? "" : `<option value="${esc(cur)}" selected>${esc(cur)}</option>`;
  return `<select id="${id}">
    ${std.map((l) => `<option value="${l}" ${cur === l ? "selected" : ""}>${l}</option>`).join("")}
    ${extra}
  </select>`;
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
      <label title="${t("只处理非维护者发起的条目")}"><input class="r-others" type="checkbox" ${others ? "checked" : ""}> ${t("仅他人")}</label>
      <input class="r-ignore" type="text" placeholder="${t("忽略作者,逗号分隔")}" value="${esc(ignores)}">
      <button type="button" class="ghost" onclick="this.parentElement.remove()" aria-label="移除该仓库">${icon("x", 13)}</button>
    </div>`;
  };

  return page(
    t("设置"),
    `<h1>${t("设置")}</h1>
     <p class="meta">${t("引擎状态：")}${engine.configured ? `<span class="dot on"></span>${t("运行中")}` : `<span class="dot"></span>${t("未配置（保存后自动启动）")}`}</p>

     <h2>${icon("lock", 13)} ${t("认证")}</h2>
     <div class="panel">
       <label class="field">${t("GitHub Token（需要对所监控仓库的写权限）")}
         <input id="s-github" type="password" autocomplete="off" value="${v(raw.github_token, "")}"></label>
       <label class="field">${t("Claude Token（可选。留空 = 使用本机 Claude Code 登录态；sk-ant-oat… 视为订阅 OAuth token，其他 sk-ant-… 视为 API Key）")}
         <input id="s-claude" type="password" autocomplete="off" value="${v(raw.claude_token, "")}"></label>
     </div>

     <h2>${icon("cpu", 13)} ${t("判定与轮询")}</h2>
     <div class="panel grid">
       <label class="field">${t("判定模型")}
         <input id="s-model" type="text" value="${v(raw.model, "claude-opus-4-8")}"></label>
       <label class="field">${t("轮询间隔（分钟）")}
         <input id="s-interval" type="number" min="1" value="${v(raw.poll_interval_minutes, "5")}"></label>
     </div>

     <h2>${icon("globe", 13)} ${t("语言")}</h2>
     <div class="panel grid">
       <label class="field">${t("界面语言")}
         <select id="s-uilang">
           <option value="zh" ${raw.ui_language !== "en" ? "selected" : ""}>中文</option>
           <option value="en" ${raw.ui_language === "en" ? "selected" : ""}>English</option>
         </select></label>
       <label class="field">${t("展示语言（判定内容给你看的语言：判断依据、草稿预览）")}
         ${langSelect("s-displang", String(raw.display_language ?? "中文"))}</label>
       <label class="field">${t("发布语言（回复和 Review 实际发布到 GitHub 使用的语言）")}
         ${langSelect("s-postlang", String(raw.post_language ?? "English"))}</label>
     </div>

     <h2>${icon("repo", 13)} ${t("仓库")}</h2>
     <div class="panel">
       <div id="repos">${repos.map(repoRow).join("")}</div>
       <button type="button" class="ghost" onclick="addRepo()">${icon("plus", 14)} ${t("添加仓库")}</button>
       <template id="repo-tpl">${repoRow({})}</template>
     </div>

     <div class="actions" style="margin-top:1.5rem">
       <button onclick="save()">${icon("save", 14)} ${t("保存并应用")}</button>
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
         ui_language:document.getElementById('s-uilang').value,
         display_language:document.getElementById('s-displang').value.trim()||'中文',
         post_language:document.getElementById('s-postlang').value.trim()||'English',
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
         if(out.ok){ msg.textContent='${UI === "en" ? "✅ Saved and applied — redirecting…" : "✅ 已保存并应用，正在跳转…"}'; setTimeout(function(){location.href='/inbox'},800); }
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
    return sendJson(res, 400, { ok: false, error: t("无效的 JSON") });
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

function renderInboxCard(store: Store, p: PendingDecision): string {
  const d = p.decision;
  const conf = Math.round(d.confidence * 100);
  const tok = `<input type="hidden" name="token" value="${esc(p.token)}">`;
  const ignoreForm = `<form method="post" action="/card/${p.id}/ignore" class="inline">${tok}<button class="ghost">${icon("ban", 14)} ${t("忽略")}</button></form>`;

  let body: string;
  if (d.needsReply && p.itemType === "pull_request") {
    const url = `/review/${p.id}?t=${encodeURIComponent(p.token)}`;
    const n = d.reviewPoints.length;
    const countLine = UI === "en" ? `<b>${n}</b> review point${n === 1 ? "" : "s"}` : `PR 审查意见 <b>${n}</b> 条`;
    body = `<p>${icon("search", 14)} ${countLine}</p>
      <div class="actions"><a class="btn" href="${url}">${icon("search", 14)} ${t("逐条审核并提交")}</a>${ignoreForm}</div>`;
  } else if (d.needsReply) {
    const preview = displayText(d.draftReplyZh, d.draftReply);
    const outgoing = postText(d.draftReplyZh, d.draftReply);
    body = `<details><summary>${icon("msg", 14)} ${t("草稿回复（点开审阅/编辑）")}</summary>
      <div class="draft">
        ${langTabs()}
        <div class="lang-zh"><p class="meta">${previewLabel()}</p><pre>${esc(preview)}</pre></div>
        <form method="post" action="/card/${p.id}/reply" onsubmit="return confirm('${esc(t("确定要将这条回复发布到 GitHub 吗？"))}')">${tok}
          <div class="lang-en"><p class="meta">${outgoingLabel(true)}</p>
            <textarea name="body" rows="6">${esc(outgoing)}</textarea></div>
          <div class="actions"><button>${icon("check", 14)} ${t("批准并回复")}</button></div>
        </form>
      </div></details>
      <div class="actions">${ignoreForm}</div>`;
  } else {
    const label = ACTION_LABEL[d.suggestedAction];
    const labels =
      d.suggestedAction === "add_labels" && d.labels.length
        ? `<p>${icon("tag", 14)} ${esc(d.labels.join(", "))}</p>`
        : "";
    const act =
      d.suggestedAction === "none"
        ? ""
        : `<form method="post" action="/card/${p.id}/act" class="inline" onsubmit="return confirm('${
            UI === "en" ? `Execute ${esc(t(label))} on GitHub?` : `确定要执行「${esc(label)}」吗？该操作将写入 GitHub。`
          }')">${tok}<button>${icon("check", 14)} ${UI === "en" ? `Execute "${esc(t(label))}"` : `执行「${esc(label)}」`}</button></form>`;
    body = `<p>${icon("wrench", 14)} ${UI === "en" ? "Suggested action" : "建议动作"}: <b>${esc(t(label))}</b></p>${labels}
      <div class="actions">${act}${ignoreForm}</div>`;
  }

  const tag =
    p.itemType === "pull_request"
      ? `<span class="tag tag-pr">PR</span>`
      : `<span class="tag tag-issue">Issue</span>`;
  return `<div class="card">
    <div class="cardhead">${tag}<b>${esc(p.owner)}/${esc(p.repo)}</b><span>#${p.number}</span>
      <a class="ext" href="${esc(p.htmlUrl)}" target="_blank" rel="noopener">${t("在 GitHub 打开")} ${icon("ext", 12)}</a></div>
    <div class="title">${esc(clip(p.title, 200))}</div>
    <div class="reasoning">${icon("spark", 14)} ${esc(clip(displayText(d.reasoning, d.reasoningEn), 600))} <span class="meta">${confLabel(conf)}</span></div>
    ${body}
    ${renderCardHistory(store, p)}
  </div>`;
}

/** Stable per-user tint class for timeline entries (readability: who said what). */
function userColorClass(author: string): string {
  let h = 0;
  for (const ch of author) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 997;
  return `tlu-${h % 6}`;
}

/** Timeline entry header: author + OP marker + review state + time. */
function tlHead(author: string, opAuthor: string, e?: { kind: string; reviewState?: string }, at?: string): string {
  return `<div class="tlhead"><b>${esc(author)}</b>
    ${author === opAuthor ? `<span class="chip st-op">${t("作者")}</span>` : ""}
    ${e?.kind === "review" ? `<span class="chip st-review">${esc(e.reviewState ?? "REVIEW")}</span>` : ""}
    ${at ? `<span class="meta">${esc(fmtWhen(Date.parse(at)))}</span>` : ""}</div>`;
}

/** Collapsed conversation history under a pending card (from the local archive). */
const CARD_HISTORY_MAX = 20;
function renderCardHistory(store: Store, p: PendingDecision): string {
  const it = store.getArchiveItem(`${p.owner}/${p.repo}`, p.itemType, p.number);
  const itemUrl = `/item/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/${p.number}`;
  if (!it) {
    return `<details class="cardhist"><summary>${icon("clock", 14)} ${t("历史")}</summary>
      <p class="meta">${t("该条目尚未同步到本地档案")}</p></details>`;
  }
  // Opening post first, then the most recent comments/reviews.
  const opening = `<li class="${userColorClass(it.author)}">${tlHead(it.author, it.author, undefined, it.ghCreatedAt)}
    ${it.body.trim() ? `<div class="tlbody md">${mdToHtml(clipMd(it.body, 600))}</div>` : ""}</li>`;
  const recent = it.timeline.slice(-CARD_HISTORY_MAX);
  const entries = recent
    .map(
      (e) => `<li class="${userColorClass(e.author)}">${tlHead(e.author, it.author, e, e.createdAt)}
        ${e.body.trim() ? `<div class="tlbody md">${mdToHtml(clipMd(e.body, 600))}</div>` : ""}</li>`,
    )
    .join("");
  const more =
    it.timeline.length > CARD_HISTORY_MAX
      ? `<p class="meta"><a href="${itemUrl}">${t("查看完整历史")}（${it.timeline.length}）</a></p>`
      : "";
  return `<details class="cardhist"><summary>${icon("clock", 14)} ${t("历史")}${
    it.timeline.length ? ` (${it.timeline.length})` : ""
  }</summary><ul class="tl">${opening}${entries}</ul>${more}</details>`;
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
  if (!p) return send(res, 404, page(t("未找到"), `<p>${t("卡片不存在。")}</p>`));
  const form = new URLSearchParams(await readBody(req));
  if ((form.get("token") ?? "") !== p.token) {
    return send(res, 403, page(t("无权访问"), `<p>${t("token 不匹配。")}</p>`));
  }

  try {
    if (action === "ignore") {
      engine.ignore(id);
    } else if (action === "restore") {
      engine.restore(id);
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
        t("操作失败"),
        `<h1>❌ ${t("操作失败")}</h1><p>${esc((e as Error).message)}</p>
         <p class="meta">${t("卡片状态未变，可回到 Inbox 重试。")}</p><p><a href="/inbox">${t("← 返回 Inbox")}</a></p>`,
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
  if (!p) return send(res, 404, page(t("未找到"), `<p>${t("该草稿不存在或已过期。")}</p>`));
  const typeLabel = p.itemType === "pull_request" ? "PR" : "Issue";
  const en = postText(p.decision.draftReplyZh, p.decision.draftReply) || "(no draft)";
  const zh = displayText(p.decision.draftReplyZh, p.decision.draftReply) || en;
  send(
    res,
    200,
    page(
      `${p.owner}/${p.repo} #${p.number}`,
      `<h1><span class="tag ${p.itemType === "pull_request" ? "tag-pr" : "tag-issue"}">${typeLabel}</span> ${esc(p.owner)}/${esc(p.repo)} #${p.number}</h1>
       <p class="meta"><a href="${esc(p.htmlUrl)}" target="_blank" rel="noopener">${t("在 GitHub 打开")} ${icon("ext", 12)}</a> · <span class="chip st-${esc(p.status)}">${esc(t(STATUS_LABEL[p.status] ?? p.status))}</span></p>
       <h2>${t("判断依据")}</h2><p>${esc(displayText(p.decision.reasoning, p.decision.reasoningEn))}</p>
       ${langTabs()}
       <div class="lang-zh"><h2>${previewLabel()}</h2><pre>${esc(zh)}</pre></div>
       <div class="lang-en"><h2>${outgoingLabel()}</h2><pre>${esc(en)}</pre></div>`,
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
  const overallEn = postText(d.draftReplyZh, d.draftReply);
  const overallZh = displayText(d.draftReplyZh, d.draftReply);
  const done = p.status !== "pending" && p.status !== "awaiting_edit";

  const items = d.reviewPoints
    .map((pt, i) => {
      const lines = parsedByPath.get(pt.path);
      const anchored = pt.line != null && lines ? commentableFor(pt.path).has(pt.line) : false;
      const loc = `${esc(pt.path)}${pt.line != null ? `:${pt.line}` : ""}`;
      const warn = anchored ? "" : ` <span class="warn">${t("（无法定位到改动行，将进 review 正文）")}</span>`;
      const code = pt.line != null && lines ? snippet(lines, pt.line) : "";
      return `<li class="pt">
        <label><input type="checkbox" name="pt" value="${i}" checked ${done ? "disabled" : ""}>
          <span class="sev sev-${esc(pt.severity)}">${esc(pt.severity)}</span>
          <code>${loc}</code>${warn}</label>
        <div class="cmt lang-zh">${esc(displayText(pt.commentZh, pt.comment))}</div>
        <div class="en lang-en">${esc(postText(pt.commentZh, pt.comment))}</div>
        ${pt.evidence ? `<div class="ev">${t("依据：")}${esc(pt.evidence)}</div>` : ""}
        ${code ? `<pre class="code">${code}</pre>` : ""}
      </li>`;
    })
    .join("");

  const list = `<ul class="pts">${items || `<li>${t("（无逐行意见，提交后仅发送总体意见正文）")}</li>`}</ul>`;
  const zhBlock = `<div class="lang-zh"><h2>${t("总体意见")} · ${previewLabel()}</h2><pre>${esc(overallZh || overallEn || "(none)")}</pre></div>`;
  const handledNote = UI === "en"
    ? `This PR was already handled (status: ${esc(t(STATUS_LABEL[p.status] ?? p.status))}) — it cannot be resubmitted.`
    : `该 PR 已处理（状态：${esc(t(STATUS_LABEL[p.status] ?? p.status))}），无法再次提交。`;
  const inner = done
    ? `${langTabs()}${zhBlock}
       <div class="lang-en"><h2>${t("总体意见")} · ${outgoingLabel()}</h2><pre>${esc(overallEn || "(none)")}</pre></div>
       <h2>${t("逐条审查意见")}</h2>${list}
       <p class="meta">${handledNote}</p>`
    : `${langTabs()}
       <form method="post" action="/review/${p.id}?t=${encodeURIComponent(p.token)}" onsubmit="return confirm('${esc(t("确定要将勾选的审查意见提交到 GitHub 吗？"))}')">
        ${zhBlock}
        <div class="lang-en"><h2>${t("总体意见")} · ${outgoingLabel(true)}</h2>
          <textarea name="body" rows="6" placeholder="Leave empty to post no overall body">${esc(overallEn)}</textarea></div>
        <h2>${t("逐条审查意见（勾选采纳，未勾选不提交）")}</h2>
        ${list}
        <button type="submit">${t("提交采纳项到 GitHub")}</button>
      </form>`;

  // Full diff, collapsed per file (files with review points open by default).
  // A big PR is thousands of diff-line <div>s; parsing/laying them all out up front
  // is what makes the page slow in the browser even after gzip. So only files with
  // review points render inline — the rest go into an inert <template> and are
  // materialized on first expand (see the toggle handler in page()), keeping the
  // initial DOM small regardless of PR size.
  const withPoints = new Set(d.reviewPoints.map((rp) => rp.path));
  const diffSection = files.length
    ? `<h2>${t("改动 diff（按文件折叠）")}</h2>` +
      files
        .map((f) => {
          const lines = parsedByPath.get(f.path) ?? [];
          const body = `<pre class="code">${renderPatch(lines)}</pre>`;
          return withPoints.has(f.path)
            ? `<details open><summary>${esc(f.path)} · ${t("有审查意见")}</summary>${body}</details>`
            : `<details><summary>${esc(f.path)}</summary><template>${body}</template></details>`;
        })
        .join("")
    : "";

  return page(
    `Review ${p.owner}/${p.repo} #${p.number}`,
    `<h1><span class="tag tag-pr">PR</span> ${esc(p.owner)}/${esc(p.repo)} #${p.number}</h1>
     <p class="meta"><a href="${esc(p.htmlUrl)}" target="_blank" rel="noopener">${t("在 GitHub 打开")} ${icon("ext", 12)}</a> · <span class="chip st-${esc(p.status)}">${esc(t(STATUS_LABEL[p.status] ?? p.status))}</span></p>
     <h2>${icon("spark", 13)} ${t("判断依据")} ${confLabel(Math.round(d.confidence * 100))}</h2>
     <div class="panel">${esc(displayText(d.reasoning, d.reasoningEn))}</div>
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
    return send(res, 409, page(t("已处理过"), `<p>${t("该 PR 已处理过。")}</p>`));
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
    return send(res, 400, page(t("无内容"), `<p>${t("没有勾选任何意见，也没有总体正文，未提交。")}</p>`));
  }

  let url: string;
  try {
    url = await submitPrReview(p, body, comments);
  } catch (e) {
    // Keep the card pending so it can be retried after fixing the cause.
    const msg = (e as Error).message;
    const hint = /not accessible|403/i.test(msg)
      ? UI === "en"
        ? `<p class="meta">This looks like insufficient token permission: submitting a PR review needs <b>Pull requests: Write</b> on the repo (fine-grained PAT: Pull requests / Read and write; classic PAT: <code>repo</code>). Fix the token, restart, and resubmit from this page — nothing was posted and the card is unchanged.</p>`
        : `<p class="meta">看起来是 GITHUB_TOKEN 权限不够：提交 PR review 需要该仓库的 <b>Pull requests: Write</b> 权限（细粒度 PAT 里勾 Pull requests / Read and write，或经典 PAT 勾 <code>repo</code>）。改好 token、重启后回到本页重新提交即可——本条尚未提交、状态未变。</p>`
      : "";
    return send(
      res,
      502,
      page(t("提交失败"), `<h1>${t("提交到 GitHub 失败")}</h1><p>${esc(msg)}</p>${hint}`),
    );
  }
  engine.noteReviewSubmitted(
    p.id,
    `✅ 已提交 PR Review（行内 ${comments.length} 条）`,
    url,
  );
  const summaryLine = UI === "en"
    ? `${comments.length} inline comment${comments.length === 1 ? "" : "s"}${body ? ", plus an overall body" : ""}.`
    : `行内评论 ${comments.length} 条${body ? "，含总体正文" : ""}。`;
  send(
    res,
    200,
    page(
      t("已提交"),
      `<h1>✅ ${t("已提交 PR Review")}</h1>
       <p>${summaryLine}</p>
       <p><a href="${esc(url)}" target="_blank" rel="noopener">${t("在 GitHub 查看这次 review")}</a></p>
       <p><a href="/inbox">${t("← 返回 Inbox")}</a></p>`,
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
    const text = postText(pt.commentZh, pt.comment);
    if (pt.line != null && commentableFor(pt.path).has(pt.line)) {
      comments.push({ path: pt.path, line: pt.line, body: `**[${pt.severity}]** ${text}` });
    } else {
      const loc = `\`${pt.path}${pt.line != null ? `:${pt.line}` : ""}\``;
      extra.push(`- ${loc} **[${pt.severity}]** ${text}`);
    }
  }

  let body = (overrideBody ?? postText(d.draftReplyZh, d.draftReply)).trim();
  if (extra.length) {
    const header = isZhName(LANGS.post) ? "**其他意见：**" : "**Additional points:**";
    body += (body ? "\n\n" : "") + header + "\n" + extra.join("\n");
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
    // Everything here is dynamic local state (settings forms, card lists). A
    // heuristically-cached stale page could show or submit outdated form values.
    "cache-control": "no-store",
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

/** Global language-tab UI: preview (display language) vs outgoing (post language). */
function langTabs(): string {
  return `<div class="tabs"><button data-l="zh" class="active" onclick="setLang('zh')">${t("预览")} · ${esc(LANGS.display)}</button><button data-l="en" onclick="setLang('en')">${t("发布")} · ${esc(LANGS.post)}</button></div>`;
}

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
  return `<!doctype html><html lang="${UI}" data-lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts?.refreshSeconds ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">` : ""}
<title>${esc(title)}</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  :root{
    --bg:#f4f6fa;--surface:#fff;--surface2:#f6f8fb;--border:#e2e8f0;--border2:#eef2f7;
    --text:#0f172a;--muted:#64748b;--faint:#94a3b8;
    --accent:#2f6bff;--accent-bg:#ebf1ff;--ok:#15803d;--ok-bg:#e7f5eb;--danger:#c53030;
    /* dark navy sidebar in both themes — a distinct surface from the content column */
    --side-bg:#1c2537;--side-bg2:#141c2b;--side-text:#eef2f9;--side-muted:#a7b4ca;
    --side-hover:rgba(255,255,255,.07);--side-active:rgba(104,150,255,.2);--side-active-text:#aac6ff;
    --side-border:rgba(255,255,255,.09);--side-count:rgba(255,255,255,.1);
    --shadow:0 1px 2px rgba(15,23,42,.06),0 2px 6px rgba(15,23,42,.05);
    --shadow-lg:0 6px 20px rgba(15,23,42,.12);--r:12px;
  }
  @media(prefers-color-scheme:dark){:root{
    --bg:#0e1526;--surface:#141f36;--surface2:#1b2740;--border:#2a3a58;--border2:#223049;
    --text:#e6ecf5;--muted:#93a4bc;--faint:#64748b;
    --accent:#6494ff;--accent-bg:#1a2a4d;--ok:#3fce6f;--ok-bg:#12291c;--danger:#f27676;
    --side-bg:#070c16;--side-bg2:#05090f;--side-text:#e6ecf5;--side-muted:#94a3bb;
    --side-hover:rgba(255,255,255,.06);--side-active:rgba(104,150,255,.18);--side-active-text:#9fbdff;
    --side-border:rgba(255,255,255,.07);--side-count:rgba(255,255,255,.09);
    --shadow:0 1px 2px rgba(0,0,0,.5);--shadow-lg:0 8px 24px rgba(0,0,0,.55);
  }}
  svg.i{flex:none;vertical-align:-2px}
  h2 svg.i{margin-right:.15rem;vertical-align:-2px}
  .mark{display:inline-flex;align-items:center;justify-content:center;flex:none;
    width:1.65rem;height:1.65rem;border-radius:8px;background:var(--accent);color:#fff;margin-right:.55rem}
  .dot{display:inline-block;width:.55rem;height:.55rem;border-radius:50%;
    background:var(--faint);margin-right:.4rem;vertical-align:1px}
  .dot.on{background:#22c55e}
  .scount,.count,.navbadge,li.hist .when,.logbox{font-variant-numeric:tabular-nums}
  .empty .big svg.i{opacity:.4}
  summary,label{cursor:pointer}
  @media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
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
    display:flex;flex-direction:column;background:linear-gradient(180deg,var(--side-bg),var(--side-bg2));
    border-right:1px solid var(--side-border);padding:.85rem .6rem .7rem;overflow-y:auto}
  .sbrand{display:flex;align-items:center;font-weight:700;font-size:.95rem;letter-spacing:.01em;
    color:var(--side-text);
    /* frosted-glass header: sticky, translucent, blurs the nav scrolling beneath */
    position:sticky;top:-.85rem;z-index:2;margin:-.85rem -.6rem .5rem;padding:1rem 1.2rem .85rem;
    background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.02)),
      color-mix(in srgb,var(--side-bg) 45%,transparent);
    backdrop-filter:blur(14px) saturate(1.6);-webkit-backdrop-filter:blur(14px) saturate(1.6);
    border-bottom:1px solid var(--side-border)}
  .side a .ic{display:inline-flex;align-items:center;justify-content:center}
  .snav{display:flex;flex-direction:column;gap:1px}
  .sgap{height:.9rem}
  .side a{display:flex;align-items:center;gap:.45rem;padding:.34rem .6rem;border-radius:8px;
    color:var(--side-muted);text-decoration:none;font-size:.88rem;font-weight:550;min-width:0;
    transition:background .12s,color .12s}
  .side a .ic{width:1.2rem;text-align:center;flex:none}
  .side a .lbl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .side a.sub{padding-left:2.15rem;font-size:.83rem;font-weight:450}
  .side a:hover{background:var(--side-hover);color:var(--side-text)}
  .side a.active{background:var(--side-active);color:var(--side-active-text);font-weight:650}
  .scount{margin-left:auto;flex:none;font-size:.7rem;font-weight:700;
    background:var(--side-count);color:var(--side-muted);border-radius:99px;padding:.02rem .45rem}
  .scount.hot{background:var(--accent);color:#fff}
  .side a.active .scount{background:var(--accent);color:#fff}
  .sfoot{margin-top:auto;border-top:1px solid var(--side-border);padding-top:.55rem;
    display:flex;flex-direction:column;gap:1px}
  .sfolder .fhead{display:flex;align-items:center;gap:1px}
  .sfolder .fkids{display:flex;flex-direction:column;gap:1px}
  .sfolder .fhead>a{flex:1}
  .side .fold{background:none;border:0;color:var(--side-muted);cursor:pointer;flex:none;
    display:inline-flex;align-items:center;padding:.3rem .35rem;border-radius:6px;box-shadow:none}
  .side .fold:hover{background:var(--side-hover);color:var(--side-text);filter:none}
  .side .fold svg{transition:transform .15s}
  .sfolder.closed .fold svg{transform:rotate(-90deg)}
  .sfolder.closed .fkids{display:none}
  .shead{font-size:.68rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
    color:var(--side-muted);opacity:.75;padding:.2rem .6rem .35rem}
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
  .chip.st-merged{background:#efe7fd;color:#7d3fd6}
  .chip.st-closed,.chip.st-review{background:var(--surface2);color:var(--muted)}
  .chip.st-open{background:var(--ok-bg);color:var(--ok)}
  .sev{font-size:.72rem;font-weight:700;padding:.1rem .5rem;border-radius:99px;margin:0 .35rem}
  .sev-blocker{background:#fde3e3;color:#c02626} .sev-suggestion{background:#dcebff;color:#1d63d8}
  .sev-nit{background:var(--surface2);color:var(--muted)} .sev-question{background:#fdf3d0;color:#8a6a00}
  .sev-critical{background:#f8caca;color:#8f0e0e} .sev-high{background:#fde3e3;color:#c02626}
  .sev-medium{background:#fdf3d0;color:#8a6a00} .sev-low{background:var(--surface2);color:var(--muted)}
  .warn{color:var(--danger);font-size:.8rem}

  /* repo analysis page */
  .repohead{display:flex;align-items:center;gap:.9rem;flex-wrap:wrap;margin:.5rem 0 1rem}
  .repohead h1{margin:0}
  .archoverview{margin:.2rem 0 1.1rem;font-size:.93rem;line-height:1.6}
  .archmap{display:flex;flex-direction:column}
  .archrow{display:flex;gap:.8rem;align-items:stretch}
  .archlabel{flex:none;width:104px;display:flex;align-items:center;justify-content:flex-end;
    text-align:right;font-size:.72rem;font-weight:700;letter-spacing:.05em;
    color:var(--muted);text-transform:uppercase}
  .architems{display:flex;flex-wrap:wrap;gap:.6rem;flex:1}
  .comp{background:var(--surface2);border:1px solid var(--border);border-radius:10px;
    padding:.55rem .75rem;flex:1 1 200px;max-width:320px}
  .comp .cname{font-weight:650;font-size:.9rem}
  .comp .cpath{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.72rem;
    color:var(--faint);margin:.1rem 0 .25rem;word-break:break-all}
  .comp .crole{font-size:.82rem;color:var(--muted);line-height:1.45}
  .cdeps{margin-top:.4rem;display:flex;flex-wrap:wrap;gap:.3rem;align-items:center}
  .cdeps .arr{color:var(--faint);font-size:.75rem}
  .dep{font-size:.7rem;font-weight:600;background:var(--surface);border:1px solid var(--border2);
    border-radius:99px;padding:.03rem .5rem;color:var(--muted)}
  .archsep{display:flex;justify-content:center;color:var(--faint);margin:.15rem 0;margin-left:104px}
  ul.findings{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.8rem}
  li.finding{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
    padding:.8rem 1rem;box-shadow:var(--shadow)}
  li.finding .fhead2{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
  li.finding .fhead2 .sev{margin:0}
  .fdetail{margin:.45rem 0 0;font-size:.88rem;line-height:1.55}
  .fsug{margin-top:.5rem;font-size:.85rem;color:var(--ok);background:var(--ok-bg);
    border-radius:8px;padding:.4rem .6rem;display:flex;gap:.4rem;align-items:baseline}

  /* history archive: done-list pager, repo sync line, item timeline */
  .pager{display:flex;gap:1rem;justify-content:center;align-items:center;margin:1.1rem 0}
  .archline{display:flex;align-items:center;gap:.8rem;flex-wrap:wrap;margin:-.4rem 0 1rem}
  .archline button{font-size:.8rem;padding:.3rem .8rem}
  .cardhead a.ext+a.ext{margin-left:.75rem}
  .cardhist{margin-top:.8rem;border-top:1px solid var(--border2);padding-top:.55rem}
  .cardhist summary{font-size:.85rem;font-weight:600;color:var(--muted)}
  .cardhist summary:hover{color:var(--text)}
  .cardhist .tl{margin-top:.6rem}
  .cardhist .tlbody{font-size:.84rem}
  ul.tl{list-style:none;padding:0;margin:0}
  ul.tl li{border-left:3px solid var(--border);border-radius:0 10px 10px 0;
    padding:.5rem .9rem .55rem;margin:0 0 .45rem;background:var(--surface2)}
  /* per-user tint (stable hash of the author name) so voices are easy to tell apart */
  ul.tl li.tlu-0{background:rgba(88,133,255,.09);border-left-color:#5885ff}
  ul.tl li.tlu-1{background:rgba(63,180,110,.09);border-left-color:#3fb46e}
  ul.tl li.tlu-2{background:rgba(155,108,255,.09);border-left-color:#9b6cff}
  ul.tl li.tlu-3{background:rgba(235,158,52,.1);border-left-color:#eb9e34}
  ul.tl li.tlu-4{background:rgba(233,92,158,.09);border-left-color:#e95c9e}
  ul.tl li.tlu-5{background:rgba(46,178,178,.09);border-left-color:#2eb2b2}
  .chip.st-op{background:var(--accent-bg);color:var(--accent)}
  .tlhead{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
  .tlhead .chip{font-size:.68rem}
  .tlbody{white-space:pre-wrap;word-wrap:break-word;font-size:.88rem;line-height:1.55;
    margin-top:.3rem;color:var(--text)}
  .tlbody.md{white-space:normal}
  .md p{margin:.35rem 0}
  .md pre{margin:.5rem 0;font-size:.8rem}
  .md blockquote{border-left:3px solid var(--border);margin:.4rem 0;padding:.1rem .8rem;color:var(--muted)}
  .md .mdh{font-weight:700;margin:.65rem 0 .3rem}
  .md .mdh1{font-size:1.02rem}.md .mdh2{font-size:.96rem}.md .mdh3{font-size:.9rem}
  .md ul,.md ol{margin:.35rem 0;padding-left:1.5rem}
  .md li{margin:.15rem 0}
  .md img{max-width:100%;max-height:420px;border-radius:8px;border:1px solid var(--border);
    display:block;margin:.45rem 0}
  .md a{word-break:break-all}
  .md hr{border:0;border-top:1px solid var(--border2);margin:.7rem 0}

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
  input[type=text],input[type=password],input[type=number],textarea,select{width:100%;font:inherit;
    padding:.5rem .7rem;border:1px solid var(--border);border-radius:8px;
    background:var(--surface);color:inherit;transition:border-color .12s,box-shadow .12s}
  input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent);
    box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
  label.field select{margin-top:.35rem;font-weight:400}
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

  /* lists */
  ul.histlist{list-style:none;padding:0;margin:0}
  li.hist{display:flex;align-items:center;gap:.55rem;padding:.5rem .1rem;font-size:.88rem;
    border-bottom:1px solid var(--border2);flex-wrap:wrap}
  li.hist:last-child{border-bottom:0}
  li.hist form.inline{margin-left:.4rem;flex:none}
  li.hist form.inline button{font-size:.78rem;padding:.12rem .55rem}

  /* language tabs */
  .tabs{display:inline-flex;background:var(--surface2);border:1px solid var(--border);
    border-radius:9px;padding:2px;gap:2px;margin:1rem 0}
  .draft{padding:.3rem .9rem .8rem}
  .draft .tabs{margin:.5rem 0 .3rem}
  .draft .meta{margin:.3rem 0}
  .draft pre{margin:.3rem 0 .5rem}
  .tabs button{background:transparent;color:var(--muted);border-radius:7px;
    padding:.22rem .95rem;font-size:.84rem;box-shadow:none}
  .tabs button:hover{filter:none;color:var(--text)}
  .tabs button.active{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
  [data-lang="zh"] .lang-en{display:none}
  [data-lang="en"] .lang-zh{display:none}
  .rtabs{margin:.2rem 0 1rem}
  [data-rview="sec"] .rv-arch{display:none}
  [data-rview="arch"] .rv-sec{display:none}
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
  .whead .logo{display:flex;width:3rem;height:3rem;border-radius:14px;margin:0 auto .7rem}
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
    .chip.st-superseded,.sev-question,.sev-medium{background:#3a2e08;color:#e3b341}
    .sev-blocker,.sev-high{background:#3a1a18;color:#f47067} .sev-suggestion{background:#182236;color:#79a8ff}
    .sev-critical{background:#4d1010;color:#ff9191}
    pre.code .hl{background:#3f2e00}
    .da{background:#12261e} .dd{background:#2b1719} .dh{color:#a371f7}
  }
</style></head><body${opts?.side ? ' class="withside"' : ""}>${opts?.side ?? ""}<main${opts?.wide ? ' class="wide"' : ""}>${inner}</main>
<script>
function setLang(l){document.documentElement.dataset.lang=l;
  for(var b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.l===l);}
function setRepoView(v){var w=document.querySelector('.rviews');if(!w)return;
  w.dataset.rview=v;
  for(var b of document.querySelectorAll('.rtabs button')) b.classList.toggle('active', b.dataset.v===v);}
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
// Sidebar folder collapse, persisted per folder across navigations/refreshes.
document.querySelectorAll('.sfolder').forEach(function(f){
  try{if(localStorage.getItem('fold:'+f.dataset.fold)==='1')f.classList.add('closed')}catch(_){}
});
document.addEventListener('click',function(e){
  var b=e.target.closest&&e.target.closest('.fold');
  if(!b) return;
  var f=b.closest('.sfolder');
  f.classList.toggle('closed');
  try{localStorage.setItem('fold:'+f.dataset.fold,f.classList.contains('closed')?'1':'')}catch(_){}
});
</script></body></html>`;
}

// ---- inline SVG icons (Lucide outlines, stroke 2 — no emoji as UI icons) ----
const ICON_PATHS: Record<string, string> = {
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  done: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  logs: '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  spark: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  repo: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
  pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
};
function icon(name: string, size = 16): string {
  return `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] ?? ""}</svg>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
