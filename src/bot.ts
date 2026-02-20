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
  AVAILABLE_MODELS,
} from "./claude.js";
import {
  claudeToTelegram,
  splitMessage,
  formatToolCall,
} from "./formatter.js";

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

  // /start command
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "<b>Claude on Phone</b>\n\n" +
        "Send any message to interact with Claude Code.\n\n" +
        "<b>Commands:</b>\n" +
        "/new - Start a fresh session\n" +
        "/model - Switch Claude model\n" +
        "/cost - Show session cost\n" +
        "/cancel - Abort current operation",
      { parse_mode: "HTML" }
    );
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

  // Shared handler: builds streaming callbacks and fires off Claude query
  function handlePrompt(chatId: number, prompt: string, bot: Bot, replyFn: (text: string) => Promise<{ message_id: number }>) {
    // This is intentionally not async — returns void so webhook doesn't block.
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
      let currentStatus = "Thinking...";
      let statusDirty = false;

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
        currentStatus = status;
        if (!buffer.trim()) {
          statusDirty = true;
          const now = Date.now();
          if (now - lastEditTime >= 1500) {
            doStatusEdit();
          }
        }
      };

      const doStatusEdit = async () => {
        if (!statusDirty) return;
        statusDirty = false;
        lastEditTime = Date.now();
        const text = `<i>${currentStatus}</i>`;
        if (text === lastEditedText) return;
        lastEditedText = text;
        try {
          await bot.api.editMessageText(chatId, thinkingMsgId, text, { parse_mode: "HTML" });
        } catch {}
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

        const html = claudeToTelegram(result.text);
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
              result.text.slice(0, 4096) || "Done."
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
              .sendMessage(chatId, result.text.slice(i * 4000, (i + 1) * 4000))
              .catch(() => {});
          }
        }

        const seconds = (result.durationMs / 1000).toFixed(1);
        const tokens = result.usage.inputTokens + result.usage.outputTokens;
        await bot.api
          .sendMessage(
            chatId,
            `${tokens.toLocaleString()} tokens | ${result.turns} turns | ${seconds}s`
          )
          .catch(() => {});
      };

      const onError = async (error: Error) => {
        if (editTimer) clearTimeout(editTimer);
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
    handlePrompt(ctx.chat.id, ctx.message.text, bot, (text) => ctx.reply(text));
  });

  // Photo message handler
  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;

    if (isProcessing(chatId)) {
      await ctx.reply("Already processing a request. Use /cancel to abort.");
      return;
    }

    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    // Download to temp file
    const tmpDir = path.join(config.CLAUDE_WORKING_DIR, ".tmp-images");
    fs.mkdirSync(tmpDir, { recursive: true });
    const ext = path.extname(file.file_path || ".jpg") || ".jpg";
    const tmpFile = path.join(tmpDir, `tg-${Date.now()}${ext}`);

    const res = await fetch(fileUrl);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmpFile, buffer);

    const caption = ctx.message.caption || "Describe this image.";
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

    // Update the approval message
    const statusLabel = approved ? "APPROVED" : "DENIED";
    try {
      const originalText = ctx.callbackQuery.message?.text || "";
      await ctx.editMessageText(`[${statusLabel}]\n${originalText}`);
    } catch {
      // Ignore edit errors
    }

    await ctx.answerCallbackQuery(approved ? "Approved" : "Denied").catch(() => {});
  });

  return bot;
}
