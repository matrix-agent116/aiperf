import { parseSettings } from "./config.ts";
import { Store } from "./store.ts";
import { TriageEngine } from "./engine.ts";
import { startHttpServer } from "./server.ts";
import { initLogCapture } from "./log.ts";
import { itemKey } from "./types.ts";

initLogCapture();

/**
 * Headless runner (no desktop shell): poll + judge + serve the local web UI.
 * Configuration lives in the sqlite settings table — configure via a browser at
 * /settings, confirm cards at /inbox. `--once` runs a single cycle and exits
 * (for testing the pipeline; requires settings to already exist in the DB).
 */
async function main(): Promise<void> {
  const once = process.argv.includes("--once");

  const store = new Store();
  const engine = new TriageEngine(store);

  engine.on("card", (p) =>
    console.log(`[card] ${itemKey(p)} awaiting confirmation (${p.title.slice(0, 60)})`),
  );
  engine.on("finalized", (ev) => console.log(`[card] ${ev.id} → ${ev.status}`));
  engine.on("reminder", (p) => console.log(`[remind] ${itemKey(p)} still open`));

  const stored = store.getSettingsRaw();
  const parsed = stored ? parseSettings(stored) : null;
  if (parsed && !parsed.ok) {
    console.warn(`[settings] stored settings invalid: ${parsed.error}`);
  }
  const config = parsed && parsed.ok ? parsed.config : null;

  if (once) {
    if (!config) {
      console.error("[main] no settings in DB; run the daemon and configure via /settings first");
      process.exit(1);
    }
    engine.setConfig(config);
    await engine.pollNow();
    store.close();
    console.log("[main] --once complete, exiting");
    process.exit(0);
  }

  // Headless default stays 0 (auto) too; pin http.port in settings if you want a
  // stable bookmarkable URL. The actual port is always printed below.
  const port = await startHttpServer(store, engine, config?.http.port ?? 0, {
    onSettingsChanged: (cfg) => {
      engine.setConfig(cfg);
      engine.start();
    },
  });
  const uiUrl = `http://127.0.0.1:${port}/inbox?auth=${encodeURIComponent(store.getOrCreateUiToken())}`;
  if (config) {
    engine.setConfig(config);
    engine.start();
    console.log(
      `[main] headless daemon running, polling every ${config.poll_interval_minutes} minute(s); open ${uiUrl}`,
    );
  } else {
    console.log(`[main] not configured yet — open ${uiUrl} to set up`);
  }

  const shutdown = () => {
    console.log("\n[main] received shutdown signal, closing…");
    engine.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[main] startup failed:", err);
  process.exit(1);
});
