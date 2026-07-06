import "dotenv/config";
import { loadConfig, type AppConfig } from "./config.ts";
import { Store } from "./store.ts";
import { pollRepo } from "./github/poller.ts";
import { judge } from "./judge/judge.ts";
import { TelegramBot } from "./telegram/bot.ts";
import { startHttpServer } from "./server.ts";
import { itemKey } from "./types.ts";

async function pollCycle(
  app: AppConfig,
  store: Store,
  tg: TelegramBot,
): Promise<void> {
  console.log(`[poll] starting cycle over ${app.repos.length} repo(s)`);
  for (const rc of app.repos) {
    const repoKey = `${rc.owner}/${rc.repo}`;
    try {
      const { items, maxSeen } = await pollRepo(app, rc, store);
      if (items.length)
        console.log(`[poll] ${repoKey}: ${items.length} item(s) to judge`);

      // Advance the cursor to the newest item seen — unless something failed, in
      // which case hold it at the earliest failure so that item is re-fetched next
      // cycle (already-pushed items are skipped by their processed fingerprint).
      let cursorTarget = maxSeen;

      for (const item of items) {
        const fingerprint = `${itemKey(item)}@${item.updatedAt}`;
        try {
          const decision = await judge(item, app.model);
          const pending = store.createPending({
            owner: item.owner,
            repo: item.repo,
            itemType: item.itemType,
            number: item.number,
            htmlUrl: item.htmlUrl,
            title: item.title,
            decision,
            draftReply: decision.draftReply ?? null,
            chatId: app.telegram.chat_id,
            context:
              item.itemType === "pull_request" && item.files
                ? { files: item.files }
                : null,
          });
          await tg.sendDecision(pending);
          store.markProcessed(fingerprint); // only after a successful push

          // The fresh card is out — cancel any older un-actioned card for this item.
          for (const stale of store.findOpenForItem(
            item.owner,
            item.repo,
            item.itemType,
            item.number,
            pending.id,
          )) {
            await tg.supersede(stale.id).catch((e) =>
              console.error(
                `[poll] failed to supersede stale card ${stale.id}:`,
                (e as Error).message,
              ),
            );
          }

          console.log(
            `[poll] pushed ${itemKey(item)} (needsReply=${decision.needsReply}, action=${decision.suggestedAction})`,
          );
        } catch (err) {
          // Don't mark processed; hold the cursor so this item is retried next cycle.
          if (item.updatedAt < cursorTarget) cursorTarget = item.updatedAt;
          console.error(
            `[poll] failed to handle ${itemKey(item)}:`,
            (err as Error).message,
          );
        }
      }

      store.setCursor(repoKey, cursorTarget);
    } catch (err) {
      console.error(`[poll] failed to poll ${repoKey}:`, (err as Error).message);
    }
  }

  await remindStale(app, store, tg);
  console.log("[poll] cycle done");
}

/** Send a one-time Telegram reminder for cards left un-actioned past the threshold. */
async function remindStale(
  app: AppConfig,
  store: Store,
  tg: TelegramBot,
): Promise<void> {
  if (!app.reminder_after_hours) return; // 0 disables
  const before = Date.now() - app.reminder_after_hours * 3600_000;
  const due = store.findDueReminders(before);
  for (const p of due) {
    try {
      await tg.sendReminder(p);
      store.markReminded(p.id);
    } catch (err) {
      console.error(`[remind] failed for ${p.id}:`, (err as Error).message);
    }
  }
  if (due.length) console.log(`[remind] sent ${due.length} reminder(s)`);
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");

  // Judging runs through the Claude Agent SDK: needs a Claude Code token or API key
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "Missing Claude auth: run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN " +
        "(or use ANTHROPIC_API_KEY instead).",
    );
  }

  const app = loadConfig();
  const store = new Store();
  const baseUrl = app.http.base_url ?? `http://localhost:${app.http.port}`;
  const tg = new TelegramBot(store, baseUrl);

  if (once) {
    // Single-shot mode: poll + judge + push, then exit (for testing the pipeline).
    // Note: the draft-preview links won't resolve since the HTTP server isn't running.
    await tg.bot.init();
    await pollCycle(app, store, tg);
    store.close();
    console.log("[main] --once complete, exiting");
    process.exit(0);
  }

  startHttpServer(store, app.http.port, (id, receipt) => {
    void tg.markSubmitted(id, receipt);
  });
  await tg.start();
  await pollCycle(app, store, tg); // run one cycle on startup
  const timer = setInterval(
    () => void pollCycle(app, store, tg),
    app.poll_interval_minutes * 60 * 1000,
  );
  console.log(
    `[main] daemon running, polling every ${app.poll_interval_minutes} minute(s)`,
  );

  const shutdown = async () => {
    console.log("\n[main] received shutdown signal, closing…");
    clearInterval(timer);
    await tg.stop();
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
