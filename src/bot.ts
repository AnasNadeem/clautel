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
  setWorkingDir,
  getWorkingDir,
  isCoolingDown,
  setLastPrompt,
  getLastPrompt,
  AVAILABLE_MODELS,
} from "./claude.js";
import {
  claudeToTelegram,
  splitMessage,
  formatToolCall,
} from "./formatter.js";
import { logUser, logStream, logResult, logError } from "./log.js";

const pendingApprovals = new Map<
  string,
  { resolve: (approved: boolean) => void; timer: NodeJS.Timeout }
>();

let approvalCounter = 0;
let retryCounter = 0;

const folderCache = new Map<string, string>();
let folderIdCounter = 0;

function getFolderId(dirPath: string): string {
  for (const [id, p] of folderCache) {
    if (p === dirPath) return id;
  }
  const id = String(++folderIdCounter);
  folderCache.set(id, dirPath);
  return id;
}

function buildFolderKeyboard(dir: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  const parent = path.dirname(dir);
  if (parent !== dir) {
    const pid = getFolderId(parent);
    keyboard.text(`.. (${path.basename(parent) || "/"})`, `fd:${pid}`).row();
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 20);

    for (const d of dirs) {
      const full = path.join(dir, d.name);
      const fid = getFolderId(full);
      keyboard.text(`📁 ${d.name}`, `fd:${fid}`).row();
    }
  } catch {}

  const selId = getFolderId(dir);
  keyboard.text("✅ Select this folder", `sf:${selId}`).row();
  return keyboard;
}

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
    "/folder — Browse and select a working directory\n" +
    "/new — Start a fresh session (clears context)\n" +
    "/model — Switch Claude model (Opus / Sonnet / Haiku)\n" +
    "/cost — Show token usage for the current session\n" +
    "/session — Get session ID to continue in CLI\n" +
    "/cancel — Abort the current operation\n" +
    "/help — Show this help message\n\n" +
    "<b>New:</b>\n" +
    "• Send documents (PDF, code files, etc.) for analysis\n" +
    "• Reply to any Claude message to include it as context\n" +
    "• Tap Retry on errors to re-run the last prompt\n\n" +
    "<b>Tips:</b>\n" +
    "• Use /folder to pick which repo Claude works in\n" +
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
    const cwd = getWorkingDir(ctx.chat.id);
    const cmd = `claude --resume ${sessionId}`;
    await ctx.reply(
      `<b>Session ID</b>\n<code>${sessionId}</code>\n\n` +
        `<b>Continue in CLI</b>\n` +
        `Run this from <code>${cwd}</code>:\n\n` +
        `<code>${cmd}</code>\n\n` +
        `Tap the command above to copy it.`,
      { parse_mode: "HTML" }
    );
  });

  // /folder command — browse and select working directory
  bot.command("folder", async (ctx) => {
    const currentDir = getWorkingDir(ctx.chat.id);
    const keyboard = buildFolderKeyboard(currentDir);
    await ctx.reply(
      `<b>Current folder:</b>\n<code>${currentDir}</code>\n\nBrowse and select a working directory:`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
  });

  function handlePrompt(chatId: number, prompt: string, bot: Bot, replyFn: (text: string) => Promise<{ message_id: number }>) {
    (async () => {
      if (isProcessing(chatId)) {
        await bot.api.sendMessage(chatId, "Already processing a request. Use /cancel to abort.");
        return;
      }

      if (isCoolingDown(chatId)) {
        await bot.api.sendMessage(chatId, "Slow down — wait a moment before sending again.");
        return;
      }

      setLastPrompt(chatId, prompt);

      await bot.api.sendChatAction(chatId, "typing");

      const thinking = await replyFn("Thinking...");
      const thinkingMsgId = thinking.message_id;

      const typingInterval = setInterval(() => {
        bot.api.sendChatAction(chatId, "typing").catch(() => {});
      }, 4000);

      let buffer = "";
      let currentActivity = "Thinking...";
      let lastEditTime = 0;
      let editTimer: NodeJS.Timeout | null = null;
      let lastEditedText = "";

      const doEdit = async () => {
        if (editTimer) {
          clearTimeout(editTimer);
          editTimer = null;
        }
        lastEditTime = Date.now();

        // Build message: streamed text + activity footer
        let content: string;
        const footer = currentActivity ? `\n\n<i>${currentActivity}</i>` : "";

        if (buffer.trim()) {
          let html = claudeToTelegram(buffer);
          const maxLen = 4000 - footer.length;
          if (html.length > maxLen) {
            html = html.slice(0, maxLen) + "\n\n<i>... streaming ...</i>";
          }
          content = html + footer;
        } else {
          content = footer.trim() || "<i>Thinking...</i>";
        }

        if (!content.trim() || content === lastEditedText) return;
        lastEditedText = content;

        try {
          await bot.api.editMessageText(chatId, thinkingMsgId, content, {
            parse_mode: "HTML",
          });
        } catch {
          // Fallback to plain text
          try {
            const plain = buffer.trim()
              ? (buffer.length > 4000 ? buffer.slice(0, 4000) + "\n\n... streaming ..." : buffer) +
                (currentActivity ? `\n\n${currentActivity}` : "")
              : currentActivity || "Thinking...";
            if (plain !== lastEditedText) {
              lastEditedText = plain;
              await bot.api.editMessageText(chatId, thinkingMsgId, plain);
            }
          } catch {
            // Ignore edit errors
          }
        }
      };

      const scheduleEdit = () => {
        const now = Date.now();
        if (now - lastEditTime >= 1500) {
          doEdit();
        } else if (!editTimer) {
          editTimer = setTimeout(doEdit, 1500 - (now - lastEditTime));
        }
      };

      const onStatusUpdate = (status: string) => {
        currentActivity = status;
        scheduleEdit();
      };

      const onStreamChunk = (chunk: string) => {
        buffer += chunk;
        currentActivity = ""; // Text streaming is its own indicator
        scheduleEdit();
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
        clearInterval(typingInterval);
        if (editTimer) clearTimeout(editTimer);

        // Use the streamed buffer if result.text is empty (can happen with tool-only responses)
        const finalText = result.text || buffer || "Done.";

        // Log full response to terminal
        logStream(finalText);

        const html = claudeToTelegram(finalText);
        const parts = splitMessage(html);

        try {
          await bot.api.deleteMessage(chatId, thinkingMsgId);
        } catch {
          await bot.api
            .editMessageText(chatId, thinkingMsgId, "⏤")
            .catch(() => {});
        }

        for (const part of parts) {
          try {
            await bot.api.sendMessage(chatId, part || "Done.", {
              parse_mode: "HTML",
            });
          } catch {
            await bot.api
              .sendMessage(chatId, part || "Done.")
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
        clearInterval(typingInterval);
        if (editTimer) clearTimeout(editTimer);
        logError(error.message);

        const retryId = String(++retryCounter);
        const keyboard = new InlineKeyboard().text("Retry", `retry:${retryId}`);

        try {
          await bot.api.editMessageText(
            chatId,
            thinkingMsgId,
            `Error: ${error.message}`,
            { reply_markup: keyboard }
          );
        } catch {
          await bot.api.sendMessage(chatId, `Error: ${error.message}`, {
            reply_markup: keyboard,
          }).catch(() => {});
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

  function extractReplyContext(ctx: { message?: { reply_to_message?: { text?: string } } }): string {
    const quoted = ctx.message?.reply_to_message?.text;
    if (!quoted) return "";
    const preview = quoted.length > 500 ? quoted.slice(0, 500) + "..." : quoted;
    return `[Replying to message: "${preview}"]

`;
  }

  bot.on("message:text", (ctx) => {
    const replyCtx = extractReplyContext(ctx);
    const prompt = replyCtx + ctx.message.text;
    logUser(ctx.message.text);
    handlePrompt(ctx.chat.id, prompt, bot, (text) => ctx.reply(text));
  });

  bot.on("message:document", async (ctx) => {
    const chatId = ctx.chat.id;

    if (isProcessing(chatId)) {
      await ctx.reply("Already processing a request. Use /cancel to abort.");
      return;
    }

    const doc = ctx.message.document;
    const file = await ctx.api.getFile(doc.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    const tmpDir = path.join(getWorkingDir(chatId), ".tmp-images");
    fs.mkdirSync(tmpDir, { recursive: true });
    const fileName = doc.file_name || `file-${Date.now()}`;
    const tmpFile = path.join(tmpDir, fileName);

    const res = await fetch(fileUrl);
    const arrayBuf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmpFile, arrayBuf);

    const caption = ctx.message.caption || `Analyze this file: ${fileName}`;
    logUser(`[document: ${fileName}] ${caption}`);
    const replyCtx = extractReplyContext(ctx);
    const prompt = replyCtx + `I've sent you a file saved at ${tmpFile}\n\nPlease read that file, then respond to this: ${caption}`;

    handlePrompt(chatId, prompt, bot, (text) => ctx.reply(text));
  });

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

    const tmpDir = path.join(getWorkingDir(chatId), ".tmp-images");
    fs.mkdirSync(tmpDir, { recursive: true });
    const ext = path.extname(file.file_path || ".jpg") || ".jpg";
    const tmpFile = path.join(tmpDir, `tg-${Date.now()}${ext}`);

    const res = await fetch(fileUrl);
    const arrayBuf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmpFile, arrayBuf);

    const caption = ctx.message.caption || "Describe this image.";
    logUser(`[photo] ${caption}`);
    const replyCtx = extractReplyContext(ctx);
    const prompt = replyCtx + `I've sent you an image saved at ${tmpFile}\n\nPlease read/view that image file, then respond to this: ${caption}`;

    handlePrompt(chatId, prompt, bot, (text) => ctx.reply(text));
  });

  // Callback query handler for Approve/Deny buttons and model selection
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Folder navigation
    if (data.startsWith("fd:")) {
      const dir = folderCache.get(data.slice(3));
      if (!dir) {
        await ctx.answerCallbackQuery("Expired. Use /folder again.").catch(() => {});
        return;
      }
      const keyboard = buildFolderKeyboard(dir);
      await ctx.editMessageText(
        `<b>Current folder:</b>\n<code>${dir}</code>\n\nBrowse and select a working directory:`,
        { parse_mode: "HTML", reply_markup: keyboard }
      ).catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }

    // Folder selection
    if (data.startsWith("sf:")) {
      const dir = folderCache.get(data.slice(3));
      if (!dir) {
        await ctx.answerCallbackQuery("Expired. Use /folder again.").catch(() => {});
        return;
      }
      const chatId = ctx.chat!.id;
      setWorkingDir(chatId, dir);
      await ctx.editMessageText(
        `Working directory set to:\n<code>${dir}</code>\n\nSession reset. Send a message to start working.`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      await ctx.answerCallbackQuery("Folder selected").catch(() => {});
      return;
    }

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

    if (data.startsWith("retry:")) {
      const chatId = ctx.chat!.id;
      const lastPrompt = getLastPrompt(chatId);
      if (!lastPrompt) {
        await ctx.answerCallbackQuery("No previous prompt to retry.").catch(() => {});
        return;
      }
      await ctx.editMessageText(`Retrying...`).catch(() => {});
      await ctx.answerCallbackQuery("Retrying").catch(() => {});
      handlePrompt(chatId, lastPrompt, bot, (text) =>
        bot.api.sendMessage(chatId, text)
      );
      return;
    }

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
