import fs from "node:fs";
import path from "node:path";
import { Bot, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import { ClaudeBridge, AVAILABLE_MODELS } from "./claude.js";
import type { BotConfig } from "./store.js";
import {
  claudeToTelegram,
  splitMessage,
  formatToolCall,
  escapeHtml,
} from "./formatter.js";
import type { AskUserQuestion } from "./claude.js";
import { logUser, logStream, logResult, logError } from "./log.js";
import { checkLicenseForQuery, getPaymentUrl, detectClaudePlan } from "./license.js";

const TYPING_INTERVAL_MS = 4000;
const EDIT_DEBOUNCE_MS = 1500;
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
const REPLY_PREVIEW_MAX = 500;
const STREAM_MAX_LEN = 4000;
const FEEDBACK_FORM_URL = "https://forms.gle/5r3j1uqK4YP7KWSA9";

export function createWorker(botConfig: BotConfig, bridge: ClaudeBridge): Bot {
  const bot = new Bot(botConfig.token);
  const tag = botConfig.username;

  const pendingApprovals = new Map<
    string,
    { resolve: (result: "allow" | "always" | "deny") => void; timer: NodeJS.Timeout; description: string }
  >();
  const pendingPlanActions = new Map<
    string,
    { resolve: (approved: boolean) => void; timer: NodeJS.Timeout }
  >();
  const pendingAnswers = new Map<
    string,
    { resolve: (answer: string) => void; timer: NodeJS.Timeout; options: Array<{ label: string }>; question: string }
  >();
  let approvalCounter = 0;
  let retryCounter = 0;

  bot.catch((err) => {
    console.error(`[${tag}] Bot error:`, err.message);
  });

  // Owner-only guard
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.TELEGRAM_OWNER_ID) {
      await ctx.reply("Unauthorized.");
      return;
    }
    await next();
  });

  const repoName = path.basename(botConfig.workingDir);

  const helpText =
    `<b>${repoName}</b>\n` +
    `<code>${botConfig.workingDir}</code>\n\n` +
    "Send any text or photo to interact with Claude Code.\n\n" +
    "<b>Commands:</b>\n" +
    "/new — Start a fresh session (clears context)\n" +
    "/model — Switch Claude model (Opus / Sonnet / Haiku)\n" +
    "/cost — Show token usage for the current session\n" +
    "/session — Get session ID to continue in CLI\n" +
    "/cancel — Abort the current operation\n" +
    "/feedback — Send feedback or report an issue\n" +
    "/help — Show this help message\n\n" +
    "<b>Features:</b>\n" +
    "• Send documents (PDF, code files, etc.) for analysis\n" +
    "• Reply to any Claude message to include it as context\n" +
    "• Tap Retry on errors to re-run the last prompt\n\n" +
    "<b>Tips:</b>\n" +
    "• Send a photo with a caption to ask about images\n" +
    "• Claude can read, edit, and create files in your project\n" +
    "• Some tools require your approval via Approve/Deny buttons\n" +
    "• Use /cancel if a response is taking too long";

  bot.command("start", async (ctx) => {
    await ctx.reply(helpText, { parse_mode: "HTML" });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpText, { parse_mode: "HTML" });
  });

  bot.command("new", async (ctx) => {
    const chatId = ctx.chat.id;
    if (bridge.isProcessing(chatId)) {
      bridge.cancelQuery(chatId);
    }
    bridge.clearSession(chatId);
    await ctx.reply("Session cleared. Send a message to start fresh.");
  });

  bot.command("cost", async (ctx) => {
    const t = bridge.getSessionTokens(ctx.chat.id);
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

  bot.command("model", async (ctx) => {
    const current = bridge.getModel(ctx.chat.id);
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

  bot.command("cancel", async (ctx) => {
    if (bridge.cancelQuery(ctx.chat.id)) {
      await ctx.reply("Operation cancelled.");
    } else {
      await ctx.reply("Nothing running to cancel.");
    }
  });

  bot.command("session", async (ctx) => {
    const sessionId = bridge.getSessionId(ctx.chat.id);
    if (!sessionId) {
      await ctx.reply("No active session. Send a message first to start one.");
      return;
    }
    const cmd = `claude --resume ${sessionId}`;
    await ctx.reply(
      `<b>Session ID</b>\n<code>${sessionId}</code>\n\n` +
        `<b>Continue in CLI</b>\n` +
        `Run this from <code>${botConfig.workingDir}</code>:\n\n` +
        `<code>${cmd}</code>\n\n` +
        `Tap the command above to copy it.`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("feedback", async (ctx) => {
    await ctx.reply(
      "We'd love to hear from you!\n\n" +
        `<a href="${FEEDBACK_FORM_URL}">Open feedback form</a>`,
      { parse_mode: "HTML" }
    );
  });

  function handlePrompt(chatId: number, prompt: string, replyFn: (text: string) => Promise<{ message_id: number }>) {
    (async () => {
      // License check — gate every query
      const licenseCheck = checkLicenseForQuery();
      if (!licenseCheck.allowed) {
        const reason = licenseCheck.reason || `License required.\n\nGet a license: ${getPaymentUrl(detectClaudePlan().tier)}`;
        await bot.api.sendMessage(chatId, reason);
        return;
      }
      if (licenseCheck.warning) {
        await bot.api.sendMessage(chatId, licenseCheck.warning);
      }

      if (bridge.isProcessing(chatId)) {
        await bot.api.sendMessage(chatId, "Already processing a request. Use /cancel to abort.");
        return;
      }

      if (bridge.isCoolingDown(chatId)) {
        await bot.api.sendMessage(chatId, "Slow down — wait a moment before sending again.");
        return;
      }

      bridge.setLastPrompt(chatId, prompt);

      await bot.api.sendChatAction(chatId, "typing");

      const thinking = await replyFn("Thinking...");
      const thinkingMsgId = thinking.message_id;

      const typingInterval = setInterval(() => {
        bot.api.sendChatAction(chatId, "typing").catch(() => {});
      }, TYPING_INTERVAL_MS);

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

        let content: string;
        const footer = currentActivity ? `\n\n<i>${currentActivity}</i>` : "";

        if (buffer.trim()) {
          let html = claudeToTelegram(buffer);
          const maxLen = STREAM_MAX_LEN - footer.length;
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
          try {
            const plain = buffer.trim()
              ? (buffer.length > STREAM_MAX_LEN ? buffer.slice(0, STREAM_MAX_LEN) + "\n\n... streaming ..." : buffer) +
                (currentActivity ? `\n\n${currentActivity}` : "")
              : currentActivity || "Thinking...";
            if (plain !== lastEditedText) {
              lastEditedText = plain;
              await bot.api.editMessageText(chatId, thinkingMsgId, plain);
            }
          } catch {}
        }
      };

      const scheduleEdit = () => {
        const now = Date.now();
        if (now - lastEditTime >= EDIT_DEBOUNCE_MS) {
          doEdit();
        } else if (!editTimer) {
          editTimer = setTimeout(doEdit, EDIT_DEBOUNCE_MS - (now - lastEditTime));
        }
      };

      const onStatusUpdate = (status: string) => {
        currentActivity = status;
        scheduleEdit();
      };

      const onStreamChunk = (chunk: string) => {
        buffer += chunk;
        currentActivity = "";
        scheduleEdit();
      };

      const onPlanApproval = async (): Promise<boolean> => {
        // Send the accumulated plan text as separate messages so user can review
        if (buffer.trim()) {
          const html = claudeToTelegram(buffer);
          const parts = splitMessage(html);
          for (const part of parts) {
            try {
              await bot.api.sendMessage(chatId, part, { parse_mode: "HTML" });
            } catch {
              await bot.api.sendMessage(chatId, part).catch(() => {});
            }
          }
        }

        // Reset buffer so implementation phase streams cleanly
        buffer = "";
        currentActivity = "Waiting for plan approval...";
        scheduleEdit();

        const requestId = String(++approvalCounter);
        const keyboard = new InlineKeyboard()
          .text("Approve Plan", `plan:approve:${requestId}`)
          .row()
          .text("Reject Plan", `plan:reject:${requestId}`);

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingPlanActions.delete(requestId);
            resolve(false);
          }, APPROVAL_TIMEOUT_MS);

          pendingPlanActions.set(requestId, { resolve, timer });

          bot.api
            .sendMessage(chatId, "<b>Approve this plan?</b>", {
              parse_mode: "HTML",
              reply_markup: keyboard,
            })
            .catch(() => {
              clearTimeout(timer);
              pendingPlanActions.delete(requestId);
              resolve(false);
            });
        });
      };

      const onAskUser = async (questions: AskUserQuestion[]): Promise<Record<string, string>> => {
        const answers: Record<string, string> = {};

        for (let i = 0; i < questions.length; i++) {
          const q = questions[i];
          const requestId = String(++approvalCounter);

          const keyboard = new InlineKeyboard();
          q.options.forEach((opt, optIdx) => {
            keyboard.text(opt.label, `answer:${requestId}:${optIdx}`);
            if (optIdx < q.options.length - 1) keyboard.row();
          });

          const answer = await new Promise<string>((resolve) => {
            const timer = setTimeout(() => {
              pendingAnswers.delete(requestId);
              resolve(q.options[0]?.label || "");
            }, APPROVAL_TIMEOUT_MS);

            pendingAnswers.set(requestId, { resolve, timer, options: q.options, question: q.question });

            const desc = q.options.map((o) => `• <b>${escapeHtml(o.label)}</b> — ${escapeHtml(o.description)}`).join("\n");
            bot.api
              .sendMessage(
                chatId,
                `<b>${escapeHtml(q.header)}</b>\n${escapeHtml(q.question)}\n\n${desc}`,
                { parse_mode: "HTML", reply_markup: keyboard }
              )
              .catch(() => {
                clearTimeout(timer);
                pendingAnswers.delete(requestId);
                resolve(q.options[0]?.label || "");
              });
          });

          answers[String(i)] = answer;
        }

        return answers;
      };

      const onToolApproval = (
        toolName: string,
        input: Record<string, unknown>
      ): Promise<"allow" | "always" | "deny"> => {
        return new Promise((resolve) => {
          const requestId = String(++approvalCounter);

          const timer = setTimeout(() => {
            pendingApprovals.delete(requestId);
            resolve("deny");
          }, APPROVAL_TIMEOUT_MS);

          const description = formatToolCall(toolName, input);

          pendingApprovals.set(requestId, { resolve, timer, description });
          const keyboard = new InlineKeyboard()
            .text("Approve", `approve:${requestId}`)
            .text("Always Allow", `alwaysallow:${requestId}`)
            .row()
            .text("Deny", `deny:${requestId}`);

          bot.api
            .sendMessage(chatId, description, {
              parse_mode: "HTML",
              reply_markup: keyboard,
            })
            .catch(() => {
              clearTimeout(timer);
              pendingApprovals.delete(requestId);
              resolve("deny");
            });
        });
      };

      let responseHandled = false;

      const onResult = async (result: {
        text: string;
        usage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number };
        turns: number;
        durationMs: number;
      }) => {
        responseHandled = true;
        clearInterval(typingInterval);
        if (editTimer) clearTimeout(editTimer);

        const finalText = buffer || result.text || "Done.";

        logStream(finalText, tag);

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
        logResult(tokens, result.turns, seconds, tag);
        await bot.api
          .sendMessage(
            chatId,
            `${tokens.toLocaleString()} tokens | ${result.turns} turns | ${seconds}s`
          )
          .catch(() => {});
      };

      const onError = async (error: Error) => {
        responseHandled = true;
        clearInterval(typingInterval);
        if (editTimer) clearTimeout(editTimer);
        logError(error.message, tag);

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

      await bridge.sendMessage(chatId, prompt, {
        onStreamChunk,
        onStatusUpdate,
        onToolApproval,
        onAskUser,
        onPlanApproval,
        onResult,
        onError,
      });

      // Runs if cancelled (onResult/onError were never called)
      if (!responseHandled) {
        clearInterval(typingInterval);
        if (editTimer) clearTimeout(editTimer);
        try {
          await bot.api.deleteMessage(chatId, thinkingMsgId);
        } catch {
          await bot.api.editMessageText(chatId, thinkingMsgId, "Cancelled.").catch(() => {});
        }
      }
    })().catch((err) => {
      console.error(`[${tag}] handlePrompt error:`, err);
    });
  }

  function extractReplyContext(ctx: { message?: { reply_to_message?: { text?: string } } }): string {
    const quoted = ctx.message?.reply_to_message?.text;
    if (!quoted) return "";
    const preview = quoted.length > REPLY_PREVIEW_MAX ? quoted.slice(0, REPLY_PREVIEW_MAX) + "..." : quoted;
    return `[Replying to message: "${preview}"]\n\n`;
  }

  bot.on("message:text", (ctx) => {
    const replyCtx = extractReplyContext(ctx);
    const prompt = replyCtx + ctx.message.text;
    logUser(ctx.message.text, tag);
    handlePrompt(ctx.chat.id, prompt, (text) => ctx.reply(text));
  });

  bot.on("message:document", async (ctx) => {
    const chatId = ctx.chat.id;

    if (bridge.isProcessing(chatId)) {
      await ctx.reply("Already processing a request. Use /cancel to abort.");
      return;
    }

    const doc = ctx.message.document;
    if (doc.file_size && doc.file_size > MAX_DOWNLOAD_BYTES) {
      await ctx.reply(`File too large (${(doc.file_size / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`);
      return;
    }

    const file = await ctx.api.getFile(doc.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${botConfig.token}/${file.file_path}`;

    const tmpDir = bridge.getTempDir();
    fs.mkdirSync(tmpDir, { recursive: true });
    const fileName = doc.file_name || `file-${Date.now()}`;
    const tmpFile = path.join(tmpDir, fileName);

    const res = await fetch(fileUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const contentLength = Number(res.headers.get("content-length") || 0);
    if (contentLength > MAX_DOWNLOAD_BYTES) {
      await ctx.reply(`File too large (${(contentLength / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`);
      return;
    }
    const arrayBuf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmpFile, arrayBuf);

    const caption = ctx.message.caption || `Analyze this file: ${fileName}`;
    logUser(`[document: ${fileName}] ${caption}`, tag);
    const replyCtx = extractReplyContext(ctx);
    const prompt = replyCtx + `I've sent you a file saved at ${tmpFile}\n\nPlease read that file, then respond to this: ${caption}`;

    handlePrompt(chatId, prompt, (text) => ctx.reply(text));
  });

  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;

    if (bridge.isProcessing(chatId)) {
      await ctx.reply("Already processing a request. Use /cancel to abort.");
      return;
    }

    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    if (photo.file_size && photo.file_size > MAX_DOWNLOAD_BYTES) {
      await ctx.reply(`Photo too large (${(photo.file_size / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`);
      return;
    }

    const file = await ctx.api.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${botConfig.token}/${file.file_path}`;

    const tmpDir = bridge.getTempDir();
    fs.mkdirSync(tmpDir, { recursive: true });
    const ext = path.extname(file.file_path || ".jpg") || ".jpg";
    const tmpFile = path.join(tmpDir, `tg-${Date.now()}${ext}`);

    const res = await fetch(fileUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const contentLength = Number(res.headers.get("content-length") || 0);
    if (contentLength > MAX_DOWNLOAD_BYTES) {
      await ctx.reply(`Photo too large (${(contentLength / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`);
      return;
    }
    const arrayBuf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmpFile, arrayBuf);

    const caption = ctx.message.caption || "Describe this image.";
    logUser(`[photo] ${caption}`, tag);
    const replyCtx = extractReplyContext(ctx);
    const prompt = replyCtx + `I've sent you an image saved at ${tmpFile}\n\nPlease read/view that image file, then respond to this: ${caption}`;

    handlePrompt(chatId, prompt, (text) => ctx.reply(text));
  });

  // Callback query handler for Approve/Deny, model selection, retry
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Model selection
    const modelMatch = data.match(/^model:(.+)$/);
    if (modelMatch) {
      const modelId = modelMatch[1];
      const chatId = ctx.chat!.id;
      const label =
        AVAILABLE_MODELS.find((m) => m.id === modelId)?.label || modelId;

      bridge.setModel(chatId, modelId);

      await ctx.editMessageText(
        `Model switched to <b>${label}</b>\nSession reset — next message uses the new model.`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      await ctx.answerCallbackQuery(`Switched to ${label}`).catch(() => {});
      return;
    }

    // Plan approval
    if (data.startsWith("plan:")) {
      const parts = data.split(":");
      const action = parts[1];
      const requestId = parts[2];
      const pending = pendingPlanActions.get(requestId);
      if (!pending) {
        await ctx.answerCallbackQuery("Request expired").catch(() => {});
        return;
      }
      clearTimeout(pending.timer);
      pendingPlanActions.delete(requestId);

      const approved = action === "approve";
      pending.resolve(approved);

      await ctx.editMessageText(approved ? "Plan approved." : "Plan rejected.").catch(() => {});
      await ctx.answerCallbackQuery(approved ? "Plan approved" : "Plan rejected").catch(() => {});
      return;
    }

    // Question answer
    if (data.startsWith("answer:")) {
      const parts = data.split(":");
      const requestId = parts[1];
      const optIdx = Number(parts[2]);
      const pending = pendingAnswers.get(requestId);
      if (!pending) {
        await ctx.answerCallbackQuery("Request expired").catch(() => {});
        return;
      }
      clearTimeout(pending.timer);
      pendingAnswers.delete(requestId);

      const selectedLabel = pending.options[optIdx]?.label || "";
      pending.resolve(selectedLabel);

      await ctx
        .editMessageText(`<b>${escapeHtml(pending.question)}</b>\n\nSelected: <b>${escapeHtml(selectedLabel)}</b>`, {
          parse_mode: "HTML",
        })
        .catch(() => {});
      await ctx.answerCallbackQuery(`Selected: ${selectedLabel}`).catch(() => {});
      return;
    }

    if (data.startsWith("retry:")) {
      const chatId = ctx.chat!.id;
      const lastPrompt = bridge.getLastPrompt(chatId);
      if (!lastPrompt) {
        await ctx.answerCallbackQuery("No previous prompt to retry.").catch(() => {});
        return;
      }
      await ctx.editMessageText(`Retrying...`).catch(() => {});
      await ctx.answerCallbackQuery("Retrying").catch(() => {});
      handlePrompt(chatId, lastPrompt, (text) =>
        bot.api.sendMessage(chatId, text)
      );
      return;
    }

    const match = data.match(/^(approve|alwaysallow|deny):(\d+)$/);
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

    const result: "allow" | "always" | "deny" =
      action === "approve"     ? "allow"  :
      action === "alwaysallow" ? "always" :
                                 "deny";

    pending.resolve(result);

    const statusLabel =
      result === "allow"  ? "APPROVED" :
      result === "always" ? "ALWAYS ALLOWED" :
                            "DENIED";

    try {
      await ctx.editMessageText(`[${statusLabel}]\n${pending.description}`, {
        parse_mode: "HTML",
      });
    } catch {}

    const answerText =
      result === "allow"  ? "Approved" :
      result === "always" ? "Allowed for this session" :
                            "Denied";

    await ctx.answerCallbackQuery(answerText).catch(() => {});
  });

  return bot;
}
