import { parseSettings } from "./config.ts";
import { Store } from "./store.ts";
import { TriageEngine } from "./engine.ts";
import { startHttpServer } from "./server.ts";
import { initLogCapture } from "./log.ts";

// Capture console output from the very start so /logs shows the full boot.
initLogCapture();

/**
 * Core entrypoint when running inside the Electron desktop shell's utilityProcess.
 * All configuration lives in the sqlite settings table (edited on /settings) —
 * no config files, no env vars. Talks to the main process over `process.parentPort`:
 *   → {type:"ready", port, configured}         server is up, load the window
 *   → {type:"card", card:{…}}                  fresh decision — show a notification
 *   → {type:"badge", count}                    open-card count for tray/dock badge
 *   ← {type:"pollNow"}                         tray menu / wake-from-sleep kick
 *   ← {type:"shutdown"}                        graceful exit
 */

// The Agent SDK spawns its bundled CLI with process.execPath — inside Electron
// that's the Electron helper binary; this makes the spawned child act as plain Node.
process.env.ELECTRON_RUN_AS_NODE = "1";

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (e: { data: any }) => void): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  throw new Error(
    "desktop-entry.ts must run inside an Electron utilityProcess (use headless.ts otherwise)",
  );
}
const send = (message: unknown): void => parentPort.postMessage(message);

/** Compact card summary for notifications (full data is rendered by the web pages). */
function cardSummary(p: {
  id: string;
  owner: string;
  repo: string;
  itemType: string;
  number: number;
  title: string;
  decision: { needsReply: boolean; reasoning: string };
}) {
  return {
    id: p.id,
    repo: `${p.owner}/${p.repo}`,
    itemType: p.itemType,
    number: p.number,
    title: p.title.slice(0, 120),
    needsReply: p.decision.needsReply,
    reasoning: p.decision.reasoning.slice(0, 160),
  };
}

const store = new Store();
const engine = new TriageEngine(store);
const sendBadge = (): void => send({ type: "badge", count: store.countOpen() });

engine.on("card", (p) => {
  send({ type: "card", card: cardSummary(p) });
  sendBadge();
});
engine.on("finalized", () => sendBadge());
engine.on("cycle", ({ phase }) => {
  if (phase === "done") sendBadge();
});

parentPort.on("message", (e) => {
  const msg = e.data as { type?: string } | undefined;
  if (msg?.type === "pollNow") void engine.pollNow();
  if (msg?.type === "shutdown") {
    engine.stop();
    store.close();
    process.exit(0);
  }
});

// Boot from stored settings; unconfigured is fine — the server still comes up and
// /inbox redirects to the /setup wizard, whose save hook starts the engine.
const stored = store.getSettingsRaw();
const parsed = stored ? parseSettings(stored) : null;
if (parsed && !parsed.ok) {
  console.warn(`[settings] stored settings invalid, reconfigure on /settings: ${parsed.error}`);
}
const config = parsed && parsed.ok ? parsed.config : null;

// Port 0 = OS-assigned free port (always): cannot conflict with another app; the
// shell learns the actual port from the ready message below.
const port = await startHttpServer(store, engine, 0, {
  onSettingsChanged: (cfg) => {
    engine.setConfig(cfg);
    engine.start(); // no-op if already running; setConfig restarted the timer if needed
  },
});
if (config) {
  engine.setConfig(config);
  engine.start();
}
send({
  type: "ready",
  port,
  configured: engine.configured,
  // The shell puts this in the window URL; the server then sets a session cookie.
  uiToken: store.getOrCreateUiToken(),
});
sendBadge();
