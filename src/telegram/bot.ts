import { Bot } from "grammy";
import type { Store, PendingDecision } from "../store.ts";
import { requireEnv } from "../config.ts";
import { renderMessage } from "./render.ts";
import { executeSuggestedAction, postReply } from "../github/actions.ts";

export class TelegramBot {
  readonly bot: Bot;
  private store: Store;
  private baseUrl: string;

  constructor(store: Store, baseUrl: string) {
    this.store = store;
    this.baseUrl = baseUrl;
    this.bot = new Bot(requireEnv("TELEGRAM_BOT_TOKEN"));
    this.registerHandlers();
  }

  /** Render and push a decision awaiting confirmation; record message_id for later receipt edits */
  async sendDecision(p: PendingDecision): Promise<void> {
    const { text, keyboard } = renderMessage(p, this.baseUrl);
    const msg = await this.bot.api.sendMessage(p.chatId, text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
    this.store.setPendingMessageId(p.id, msg.message_id);
  }

  /**
   * Cancel a stale card: strip its buttons and mark it superseded, so only the
   * freshest card for an issue/PR stays actionable.
   */
  async supersede(id: string): Promise<void> {
    const p = this.store.getPending(id);
    if (!p) return;
    this.store.setPendingStatus(id, "superseded");
    await this.finalize(p, "🔄 该 issue/PR 有新活动，此卡已被新卡片取代");
  }

  /** Nudge a card left un-actioned too long; replies to the original card message */
  async sendReminder(p: PendingDecision): Promise<void> {
    const typeLabel = p.itemType === "pull_request" ? "PR" : "Issue";
    const hours = Math.max(1, Math.floor((Date.now() - p.createdAt) / 3600_000));
    const text =
      `⏰ 提醒：这张卡片已 ${hours} 小时未处理\n` +
      `${p.owner}/${p.repo} · ${typeLabel} #${p.number}\n${p.htmlUrl}`;
    await this.bot.api.sendMessage(p.chatId, text, {
      reply_parameters: p.messageId ? { message_id: p.messageId } : undefined,
      link_preview_options: { is_disabled: true },
    });
  }

  /** Called by the HTTP server after a PR review is submitted on the web page:
   *  strip the card's buttons and append the receipt. Status is set by the server. */
  async markSubmitted(id: string, receipt: string): Promise<void> {
    const p = this.store.getPending(id);
    if (p) await this.finalize(p, receipt);
  }

  /** Start long polling (non-blocking; the caller drives its own loop) */
  async start(): Promise<void> {
    await this.bot.init();
    // Don't await bot.start() (it blocks forever) — let the caller decide
    void this.bot.start({ drop_pending_updates: false });
    console.log(`[telegram] bot @${this.bot.botInfo.username} started long polling`);
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  private registerHandlers(): void {
    const bot = this.bot;

    bot.callbackQuery(/^reply:(.+)$/, async (ctx) => {
      const p = this.load(ctx.match[1]);
      if (!p) return ctx.answerCallbackQuery("已失效");
      if (p.status !== "pending")
        return ctx.answerCallbackQuery("已处理过，忽略");
      try {
        const url = await postReply(p, p.draftReply ?? "");
        this.store.setPendingStatus(p.id, "replied");
        await this.finalize(p, replyReceipt(p, url));
        await ctx.answerCallbackQuery("已回复");
      } catch (err) {
        await this.reportError(ctx, err);
      }
    });

    bot.callbackQuery(/^edit:(.+)$/, async (ctx) => {
      const p = this.load(ctx.match[1]);
      if (!p) return ctx.answerCallbackQuery("已失效");
      if (p.status !== "pending")
        return ctx.answerCallbackQuery("已处理过，忽略");
      this.store.setPendingStatus(p.id, "awaiting_edit");
      await ctx.answerCallbackQuery();
      await ctx.reply(
        `✏️ 请直接发送修改后的回复文本（针对 ${p.owner}/${p.repo} #${p.number}），我会用它回复到 GitHub。`,
        { reply_parameters: { message_id: p.messageId ?? ctx.msgId! } },
      );
    });

    bot.callbackQuery(/^act:(.+)$/, async (ctx) => {
      const p = this.load(ctx.match[1]);
      if (!p) return ctx.answerCallbackQuery("已失效");
      if (p.status !== "pending")
        return ctx.answerCallbackQuery("已处理过，忽略");
      try {
        const receipt = await executeSuggestedAction(p);
        this.store.setPendingStatus(p.id, "executed");
        await this.finalize(p, receipt);
        await ctx.answerCallbackQuery("已执行");
      } catch (err) {
        await this.reportError(ctx, err);
      }
    });

    bot.callbackQuery(/^ignore:(.+)$/, async (ctx) => {
      const p = this.load(ctx.match[1]);
      if (!p) return ctx.answerCallbackQuery("已失效");
      this.store.setPendingStatus(p.id, "ignored");
      await this.finalize(p, "🚫 已忽略");
      await ctx.answerCallbackQuery("已忽略");
    });

    // Edited draft: user sends plain text after tapping the Edit button
    bot.on("message:text", async (ctx) => {
      const chatId = String(ctx.chat.id);
      const p = this.store.findAwaitingEdit(chatId);
      if (!p) return; // nothing awaiting an edit — ignore ordinary messages
      const newText = ctx.message.text;
      try {
        this.store.setPendingDraft(p.id, newText);
        const url = await postReply(p, newText);
        this.store.setPendingStatus(p.id, "replied");
        await this.finalize({ ...p, draftReply: newText }, replyReceipt(p, url));
        await ctx.reply(
          p.itemType === "pull_request" ? "✅ 已提交 PR Review" : "✅ 已回复到 GitHub",
        );
      } catch (err) {
        this.store.setPendingStatus(p.id, "pending"); // failed — allow retry
        await ctx.reply(`❌ 回复失败: ${(err as Error).message}`);
      }
    });

    bot.catch((err) => {
      console.error("[telegram] error handling update:", err.error);
    });
  }

  private load(id: string): PendingDecision | null {
    return this.store.getPending(id);
  }

  /** Strip the buttons and append a receipt to the original message */
  private async finalize(p: PendingDecision, receipt: string): Promise<void> {
    if (!p.messageId) return;
    const fresh = this.store.getPending(p.id) ?? p;
    const { text } = renderMessage(
      { ...fresh, draftReply: p.draftReply },
      this.baseUrl,
    );
    try {
      await this.bot.api.editMessageText(
        p.chatId,
        p.messageId,
        `${text}\n\n— ${receipt}`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      );
    } catch {
      // An edit failure (unchanged content / message too old) shouldn't break the flow
    }
  }

  private async reportError(ctx: any, err: unknown): Promise<void> {
    const msg = (err as Error).message ?? String(err);
    console.error("[telegram] action failed:", msg);
    await ctx.answerCallbackQuery({ text: `失败: ${msg}`.slice(0, 190), show_alert: true });
  }
}

/** Receipt line for a posted reply, with a link to it (PR → review, issue → comment). */
function replyReceipt(p: PendingDecision, url: string): string {
  return p.itemType === "pull_request"
    ? `✅ 已提交 PR Review · 🔗 <a href="${url}">在 GitHub 查看</a>`
    : `✅ 已回复到 GitHub · 🔗 <a href="${url}">查看这条评论</a>`;
}
