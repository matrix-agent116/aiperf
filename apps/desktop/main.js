import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  nativeImage,
  utilityProcess,
} from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(dir, "../..");
const CORE_ENTRY = path.join(rootDir, "packages/core/src/desktop-entry.ts");

let tray = null;
let win = null;
let core = null;
let port = null;
let uiToken = null;
let quitting = false;

function inboxUrl() {
  return `http://127.0.0.1:${port}/inbox?auth=${encodeURIComponent(uiToken)}`;
}

function showWindow() {
  if (win) {
    win.show();
    win.focus();
    return;
  }
  if (!port || !uiToken) return; // core not ready yet; ready handler will open it
  win = new BrowserWindow({
    // Fallback size for when the user un-maximizes; the window opens maximized.
    width: 1200,
    height: 860,
    show: false,
    title: "Git Triage",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.maximize();
  win.show();
  win.loadURL(inboxUrl());
  // Closing the window keeps the app running in the tray (menu-bar app behavior).
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    win = null;
  });
}

function updateBadge(count) {
  if (tray) tray.setTitle(count > 0 ? `📥${count}` : "📥");
  if (app.dock) app.setBadgeCount(count);
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  n.on("click", showWindow);
  n.show();
}

function startCore() {
  // All state lives under the per-user app data dir (…/Application Support/gh-triage
  // on macOS); env vars still win for development overrides.
  const dataDir = app.getPath("userData");
  core = utilityProcess.fork(CORE_ENTRY, [], {
    cwd: rootDir,
    stdio: "inherit",
    serviceName: "gh-triage-core",
    env: {
      ...process.env,
      DB_PATH: process.env.DB_PATH ?? path.join(dataDir, "state.db"),
      REPOS_DIR: process.env.REPOS_DIR ?? path.join(dataDir, "repos"),
    },
  });

  core.on("message", (msg) => {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "ready":
        port = msg.port;
        uiToken = msg.uiToken;
        if (win) win.loadURL(inboxUrl()); // core restarted — refresh the session
        else showWindow();
        break;
      case "badge":
        updateBadge(msg.count);
        break;
      case "card": {
        const c = msg.card;
        const kind = c.itemType === "pull_request" ? "PR" : "Issue";
        notify(`📥 ${c.repo} ${kind} #${c.number}`, `${c.title}\n${c.reasoning}`);
        break;
      }
    }
  });

  core.on("exit", (code) => {
    console.error(`[shell] core exited with code ${code}`);
    if (!quitting) {
      // The core is the whole app; if it dies unexpectedly, restart it once per event.
      setTimeout(startCore, 3000);
    }
  });
}

function buildTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("📥");
  tray.setToolTip("Git Triage");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 Inbox", click: showWindow },
      { label: "立即轮询", click: () => core?.postMessage({ type: "pollNow" }) },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ]),
  );
  tray.on("click", showWindow);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(() => {
    buildTray();
    startCore();
  });

  app.on("activate", showWindow); // dock icon clicked
  app.on("window-all-closed", () => {
    /* keep running in the tray */
  });

  app.on("before-quit", () => {
    quitting = true;
    core?.postMessage({ type: "shutdown" });
  });
}
