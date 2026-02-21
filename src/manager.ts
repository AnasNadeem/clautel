import fs from "node:fs";
import { Bot } from "grammy";
import { config } from "./config.js";
import type { BotConfig } from "./store.js";

export interface ManagerCallbacks {
  startWorker: (botConfig: BotConfig) => Promise<void>;
  stopWorker: (botId: number) => Promise<void>;
  getActiveWorkers: () => Map<number, { config: BotConfig }>;
}

interface ConversationState {
  step: "token" | "path";
  token?: string;
  timer: NodeJS.Timeout;
}

const CONVERSATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function createManager(callbacks: ManagerCallbacks): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  const conversations = new Map<number, ConversationState>();

  bot.catch((err) => {
    console.error("[manager] Bot error:", err.message);
  });

  // Owner-only guard
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.TELEGRAM_OWNER_ID) {
      await ctx.reply("Unauthorized.");
      return;
    }
    await next();
  });

  function setConversation(chatId: number, state: Omit<ConversationState, "timer">): void {
    const existing = conversations.get(chatId);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      conversations.delete(chatId);
      bot.api
        .sendMessage(chatId, "Setup timed out. Send /add to try again.")
        .catch(() => {});
    }, CONVERSATION_TIMEOUT_MS);

    conversations.set(chatId, { ...state, timer });
  }

  function clearConversation(chatId: number): void {
    const existing = conversations.get(chatId);
    if (existing) clearTimeout(existing.timer);
    conversations.delete(chatId);
  }

  function formatBotList(): string {
    const workers = callbacks.getActiveWorkers();
    if (workers.size === 0) return "No worker bots active.";

    const lines: string[] = [];
    for (const [, w] of workers) {
      lines.push(`• @${w.config.username} — <code>${w.config.workingDir}</code>`);
    }
    return lines.join("\n");
  }

  const helpText =
    "<b>Claude Multi-Bot Manager</b>\n\n" +
    "<b>Commands:</b>\n" +
    "/bots — List all active worker bots\n" +
    "/add — Add a new worker bot (interactive)\n" +
    "/add TOKEN /path/to/repo — Add a worker bot (inline)\n" +
    "/remove @username — Remove a worker bot\n" +
    "/cancel — Cancel current operation\n" +
    "/help — Show this help message\n\n" +
    "<b>How to add a bot:</b>\n" +
    "1. Go to @BotFather, create a new bot, copy the token\n" +
    "2. Send: <code>/add TOKEN /path/to/repo</code>\n" +
    "3. DM the new bot and start working!";

  bot.command("start", async (ctx) => {
    const botList = formatBotList();
    await ctx.reply(helpText + "\n\n<b>Active bots:</b>\n" + botList, {
      parse_mode: "HTML",
    });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpText, { parse_mode: "HTML" });
  });

  bot.command("bots", async (ctx) => {
    const botList = formatBotList();
    await ctx.reply("<b>Active bots:</b>\n" + botList, {
      parse_mode: "HTML",
    });
  });

  bot.command("cancel", async (ctx) => {
    if (conversations.has(ctx.chat.id)) {
      clearConversation(ctx.chat.id);
      await ctx.reply("Cancelled.");
    } else {
      await ctx.reply("Nothing to cancel.");
    }
  });

  bot.command("add", async (ctx) => {
    const args = ctx.match?.trim();

    if (!args) {
      setConversation(ctx.chat.id, { step: "token" });
      await ctx.reply(
        "Send me the bot token from @BotFather.\n\n" +
          "It looks like: <code>123456:ABC-DEF...</code>\n\n" +
          "Send /cancel to abort.",
        { parse_mode: "HTML" }
      );
      return;
    }

    // Inline: /add TOKEN /path/to/repo
    const spaceIdx = args.indexOf(" ");
    if (spaceIdx === -1) {
      await ctx.reply(
        "Usage: <code>/add TOKEN /path/to/repo</code>\n\n" +
          "Or just send <code>/add</code> for interactive setup.",
        { parse_mode: "HTML" }
      );
      return;
    }

    const token = args.slice(0, spaceIdx).trim();
    const dir = args.slice(spaceIdx + 1).trim();

    await addWorkerBot(ctx, token, dir);
  });

  bot.command("remove", async (ctx) => {
    const username = ctx.match?.trim().replace(/^@/, "");
    if (!username) {
      await ctx.reply("Usage: <code>/remove @bot_username</code>", {
        parse_mode: "HTML",
      });
      return;
    }

    const workers = callbacks.getActiveWorkers();
    let foundId: number | null = null;
    for (const [id, w] of workers) {
      if (w.config.username === username) {
        foundId = id;
        break;
      }
    }

    if (foundId === null) {
      await ctx.reply(`Bot @${username} not found in active workers.`);
      return;
    }

    try {
      await callbacks.stopWorker(foundId);
      await ctx.reply(`Removed @${username}. Bot stopped.`);
    } catch (err) {
      await ctx.reply(`Error removing @${username}: ${err}`);
    }
  });

  async function addWorkerBot(
    ctx: { reply: (text: string, opts?: Record<string, unknown>) => Promise<unknown>; chat: { id: number } },
    token: string,
    dir: string
  ): Promise<void> {
    if (!fs.existsSync(dir)) {
      await ctx.reply(`Path does not exist: <code>${dir}</code>`, {
        parse_mode: "HTML",
      });
      return;
    }

    if (!fs.statSync(dir).isDirectory()) {
      await ctx.reply(`Path is not a directory: <code>${dir}</code>`, {
        parse_mode: "HTML",
      });
      return;
    }

    await ctx.reply("Validating token...");

    let botInfo: { id: number; username: string };
    try {
      const tempBot = new Bot(token);
      const me = await tempBot.api.getMe();
      botInfo = { id: me.id, username: me.username || `bot_${me.id}` };
    } catch (err) {
      await ctx.reply(`Invalid bot token. Error: ${err}`);
      return;
    }

    const workers = callbacks.getActiveWorkers();
    if (workers.has(botInfo.id)) {
      await ctx.reply(
        `Bot @${botInfo.username} is already active. Remove it first with /remove @${botInfo.username}`
      );
      return;
    }

    const botConfig: BotConfig = {
      id: botInfo.id,
      token,
      username: botInfo.username,
      workingDir: dir,
    };

    try {
      await callbacks.startWorker(botConfig);
      await ctx.reply(
        `Added @${botInfo.username}\n` +
          `Repo: <code>${dir}</code>\n\n` +
          `DM @${botInfo.username} to start working!`,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      await ctx.reply(`Failed to start worker: ${err}`);
    }
  }

  // Handle conversational flow for /add
  bot.on("message:text", async (ctx) => {
    const conv = conversations.get(ctx.chat.id);
    if (!conv) return;

    const text = ctx.message.text.trim();

    if (conv.step === "token") {
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(text)) {
        await ctx.reply(
          "That doesn't look like a valid bot token.\n" +
            "It should look like: <code>123456:ABC-DEF...</code>\n\n" +
            "Try again or send /cancel to abort.",
          { parse_mode: "HTML" }
        );
        return;
      }

      setConversation(ctx.chat.id, { step: "path", token: text });
      await ctx.reply(
        "Now send the full path to the repository.\n\nExample: <code>/Users/me/projects/my-app</code>",
        { parse_mode: "HTML" }
      );
      return;
    }

    if (conv.step === "path") {
      clearConversation(ctx.chat.id);
      await addWorkerBot(ctx, conv.token!, text);
      return;
    }
  });

  return bot;
}
