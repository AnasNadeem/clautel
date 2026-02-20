import fs from "node:fs";
import path from "node:path";
import { Bot, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import {
  sendMessage,
  isProcessing,
  cancelQuery,
  clearSession,
  getSessionTokens,
  setModel,
  getModel,
  getSessionId,
  AVAILABLE_MODELS,
} from "./claude.js";
import {
  claudeToTelegram,
  splitMessage,
  formatToolCall,
} from "./formatter.js";
import { logUser, logStream, logResult, logError } from "./log.js";

// Pending approval promises: requestId → resolver
const pendingApprovals = new Map<
  string,
  { resolve: (approved: boolean) => void; timer: NodeJS.Timeout }
>();

let approvalCounter = 0;

export function createBot(): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // Global error handler — don't crash on unhandled bot errors
  bot.catch((err) => {
    console.error("Bot error:", err.message);
  });

  // Owner-only guard
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.TELEGRAM_OWNER_ID) {
      await ctx.reply("Unauthorized.");
      return;
    }
    await next();
  });

  const helpText =
    "<b>Claude on Phone</b>\n\n" +
    "Send any text or photo to interact with Claude Code.\n\n" +
    "<b>Commands:</b>\n" +
    "/new — Start a fresh session (clears context)\n" +
    "/model — Switch Claude model (Opus / Sonnet / Haiku)\n" +
    "/cost — Show token usage for the current session\n" +
    "/session — Get session ID to continue in CLI\n" +
    "/cancel — Abort the current operation\n" +
    "/help — Show this help message\n\n" +
    "<b>Tips:</b>\n" +
    "• Send a photo with a caption to ask about images\n" +
    "• Claude can read, edit, and create files in your project\n" +
    "• Some tools require your approval via Approve/Deny buttons\n" +
    "• Use /cancel if a response is taking too long";

  // /start command
  bot.command("start", async (ctx) => {
    await ctx.reply(helpText, { parse_mode: "HTML" });
  });

  // /help command
  bot.command("help", async (ctx) => {
    await ctx.reply(helpText, { parse_mode: "HTML" });
  });

  // /new command — fresh session
  bot.command("new", async (ctx) => {
    const chatId = ctx.chat.id;
    if (isProcessing(chatId)) {
      cancelQuery(chatId);
    }
    clearSession(chatId);
    await ctx.reply("Session cleared. Send a message to start fresh.");
  });

  // /cost command
  bot.command("cost", async (ctx) => {
    const t = getSessionTokens(ctx.chat.id);
    const total = t.inputTokens + t.outputTokens;
    await ctx.reply(
      `<b>Session tokens</b>\n` +
        `Input: ${t.inputTokens.toLocaleString()}\n` +
        `Output: ${t.outputTokens.toLocaleString()}\n` +
        `Cache write: ${t.cacheCreationTokens.toLocaleString()}\n` +
        `Cache read: ${t.cacheReadTokens.toLocaleString()}\n` +
        `Total: ${total.toLocaleString()}`,
      { parse_mode: "HTML" }
    );
  });

  // /model command — select Claude model
  bot.command("model", async (ctx) => {
    const current = getModel(ctx.chat.id);
    const currentLabel =
      AVAILABLE_MODELS.find((m) => m.id === current)?.label || current;

    const keyboard = new InlineKeyboard();
    for (const m of AVAILABLE_MODELS) {
      const check = m.id === current ? " (current)" : "";
      keyboard.text(`${m.label}${check}`, `model:${m.id}`).row();
    }

    await ctx.reply(`Current model: <b>${currentLabel}</b>\n\nSelect a model:`, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  });

  // /cancel command
  bot.command("cancel", async (ctx) => {
    if (cancelQuery(ctx.chat.id)) {
      await ctx.reply("Operation cancelled.");
    } else {
      await ctx.reply("Nothing running to cancel.");
    }
  });

  // /session command — get session ID to continue in CLI
  bot.command("session", async (ctx) => {
    const sessionId = getSessionId(ctx.chat.id);
    if (!sessionId) {
      await ctx.reply("No active session. Send a message first to start one.");
      return;
    }
    const cmd = `claude --resume ${sessionId}`;
    await ctx.reply(
      `<b>Session ID</b>\n<code>${sessionId}</code>\n\n` +
        `<b>Continue in CLI</b>\n` +
        `Run this from <code>${config.CLAUDE_WORKING_DIR}</code>:\n\n` +
        `<code>${cmd}</code>\n\n` +
        `Tap the command above to copy it.`,
      { parse_mode: "HTML" }
    );
  });

  // Shared handler: builds streaming callbacks and fires off Claude query
  function handlePrompt(chatId: number, prompt: string, bot: Bot, replyFn: (text: string) => Promise<{ message_id: number }>) {
    (async () => {
      if (isProcessing(chatId)) {
        await bot.api.sendMessage(chatId, "Already processing a request. Use /cancel to abort.");
        return;
      }

      const thinking = await replyFn("Thinking...");
      const thinkingMsgId = thinking.message_id;

      let buffer = "";
      let lastEditTime = 0;
      let editTimer: NodeJS.Timeout | null = null;
      let lastEditedText = "";

      const doEdit = async () => {
        if (editTimer) {
          clearTimeout(editTimer);
          editTimer = null;
        }
        lastEditTime = Date.now();

        let html = claudeToTelegram(buffer);
        if (html.length > 4000) {
          html = html.slice(0, 4000) + "\n\n<i>... streaming ...</i>";
        }

        if (!html.trim() || html === lastEditedText) return;
        lastEditedText = html;

        try {
          await bot.api.editMessageText(chatId, thinkingMsgId, html, {
            parse_mode: "HTML",
          });
        } catch {
          try {
            const plain =
              buffer.length > 4000
                ? buffer.slice(0, 4000) + "\n\n... streaming ..."
                : buffer;
            if (plain.trim()) {
              await bot.api.editMessageText(chatId, thinkingMsgId, plain);
            }
          } catch {
            // Ignore edit errors
          }
        }
      };

      const onStatusUpdate = (status: string) => {
        // Only update the Telegram message if no text has streamed yet
        if (!buffer.trim()) {
          const now = Date.now();
          if (now - lastEditTime >= 1500) {
            lastEditTime = now;
            const text = `<i>${status}</i>`;
            if (text !== lastEditedText) {
              lastEditedText = text;
              bot.api.editMessageText(chatId, thinkingMsgId, text, { parse_mode: "HTML" }).catch(() => {});
            }
          }
        }
      };

      const onStreamChunk = (chunk: string) => {
        buffer += chunk;
        const now = Date.now();
        if (now - lastEditTime >= 1500) {
          doEdit();
        } else if (!editTimer) {
          editTimer = setTimeout(doEdit, 1500 - (now - lastEditTime));
        }
      };

      const onToolApproval = (
        toolName: string,
        input: Record<string, unknown>
      ): Promise<boolean> => {
        return new Promise<boolean>((resolve) => {
          const requestId = String(++approvalCounter);

          const timer = setTimeout(() => {
            pendingApprovals.delete(requestId);
            resolve(false);
          }, 5 * 60 * 1000);

          pendingApprovals.set(requestId, { resolve, timer });

          const description = formatToolCall(toolName, input);
          const keyboard = new InlineKeyboard()
            .text("Approve", `approve:${requestId}`)
            .text("Deny", `deny:${requestId}`);

          bot.api
            .sendMessage(chatId, description, {
              parse_mode: "HTML",
              reply_markup: keyboard,
            })
            .catch(() => {
              clearTimeout(timer);
              pendingApprovals.delete(requestId);
              resolve(false);
            });
        });
      };

      const onResult = async (result: {
        text: string;
        usage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number };
        turns: number;
        durationMs: number;
      }) => {
        if (editTimer) clearTimeout(editTimer);

        // Use the streamed buffer if result.text is empty (can happen with tool-only responses)
        const finalText = result.text || buffer || "Done.";

        // Log full response to terminal
        logStream(finalText);

        const html = claudeToTelegram(finalText);
        const parts = splitMessage(html);

        try {
          await bot.api.editMessageText(
            chatId,
            thinkingMsgId,
            parts[0] || "Done.",
            { parse_mode: "HTML" }
          );
        } catch {
          try {
            await bot.api.editMessageText(
              chatId,
              thinkingMsgId,
              finalText.slice(0, 4096) || "Done."
            );
          } catch {}
        }

        for (let i = 1; i < parts.length; i++) {
          try {
            await bot.api.sendMessage(chatId, parts[i], {
              parse_mode: "HTML",
            });
          } catch {
            await bot.api
              .sendMessage(chatId, finalText.slice(i * 4000, (i + 1) * 4000))
              .catch(() => {});
          }
        }

        const seconds = (result.durationMs / 1000).toFixed(1);
        const tokens = result.usage.inputTokens + result.usage.outputTokens;
        logResult(tokens, result.turns, seconds);
        await bot.api
          .sendMessage(
            chatId,
            `${tokens.toLocaleString()} tokens | ${result.turns} turns | ${seconds}s`
          )
          .catch(() => {});
      };

      const onError = async (error: Error) => {
        if (editTimer) clearTimeout(editTimer);
        logError(error.message);
        try {
          await bot.api.editMessageText(
            chatId,
            thinkingMsgId,
            `Error: ${error.message}`
          );
        } catch {
          await bot.api.sendMessage(chatId, `Error: ${error.message}`).catch(() => {});
        }
      };

      await sendMessage(chatId, prompt, {
        onStreamChunk,
        onStatusUpdate,
        onToolApproval,
        onResult,
        onError,
      });
    })().catch((err) => {
      console.error("handlePrompt error:", err);
    });
  }

  // Text message handler
  bot.on("message:text", (ctx) => {
    logUser(ctx.message.text);
    handlePrompt(ctx.chat.id, ctx.message.text, bot, (text) => ctx.reply(text));
  });

  // Photo message handler
  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;

    if (isProcessing(chatId)) {
      await ctx.reply("Already processing a request. Use /cancel to abort.");
      return;
    }

    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    const tmpDir = path.join(config.CLAUDE_WORKING_DIR, ".tmp-images");
    fs.mkdirSync(tmpDir, { recursive: true });
    const ext = path.extname(file.file_path || ".jpg") || ".jpg";
    const tmpFile = path.join(tmpDir, `tg-${Date.now()}${ext}`);

    const res = await fetch(fileUrl);
    const arrayBuf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmpFile, arrayBuf);

    const caption = ctx.message.caption || "Describe this image.";
    logUser(`[photo] ${caption}`);
    const prompt = `I've sent you an image saved at ${tmpFile}\n\nPlease read/view that image file, then respond to this: ${caption}`;

    handlePrompt(chatId, prompt, bot, (text) => ctx.reply(text));
  });

  // Callback query handler for Approve/Deny buttons and model selection
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Model selection
    const modelMatch = data.match(/^model:(.+)$/);
    if (modelMatch) {
      const modelId = modelMatch[1];
      const chatId = ctx.chat!.id;
      const label =
        AVAILABLE_MODELS.find((m) => m.id === modelId)?.label || modelId;

      setModel(chatId, modelId);

      await ctx.editMessageText(
        `Model switched to <b>${label}</b>\nSession reset — next message uses the new model.`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      await ctx.answerCallbackQuery(`Switched to ${label}`).catch(() => {});
      return;
    }

    // Approve/Deny
    const match = data.match(/^(approve|deny):(\d+)$/);
    if (!match) {
      await ctx.answerCallbackQuery("Invalid action").catch(() => {});
      return;
    }

    const [, action, requestId] = match;
    const pending = pendingApprovals.get(requestId);

    if (!pending) {
      await ctx.answerCallbackQuery("Request expired").catch(() => {});
      return;
    }

    clearTimeout(pending.timer);
    pendingApprovals.delete(requestId);

    const approved = action === "approve";
    pending.resolve(approved);

    const statusLabel = approved ? "APPROVED" : "DENIED";
    try {
      const originalText = ctx.callbackQuery.message?.text || "";
      await ctx.editMessageText(`[${statusLabel}]\n${originalText}`);
    } catch {}

    await ctx.answerCallbackQuery(approved ? "Approved" : "Denied").catch(() => {});
  });

  return bot;
}
