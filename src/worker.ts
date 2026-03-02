import fs from "node:fs";
import path from "node:path";
import { Bot, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import { ClaudeBridge, AVAILABLE_MODELS } from "./claude.js";
import type { BotConfig } from "./store.js";
import { TunnelManager, parsePort } from "./tunnel.js";
import {
  claudeToTelegram,
  splitMessage,
  formatToolCall,
  escapeHtml,
} from "./formatter.js";
import type { AskUserQuestion } from "./claude.js";
import { logUser, logStream, logResult, logError } from "./log.js";
import { checkLicenseForQuery, getPaymentUrl, detectClaudePlan, LICENSE_CANARY } from "./license.js";

// Cross-module integrity: verify license module hasn't been patched
if (LICENSE_CANARY !== "L1c3ns3-Ch3ck-V2") {
  throw new Error("Integrity check failed: license module has been tampered with.");
}

const TYPING_INTERVAL_MS = 4000;
const EDIT_DEBOUNCE_MS = 1500;
const APPROVAL_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours — users interact async on mobile
const FETCH_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
const REPLY_PREVIEW_MAX = 500;
const STREAM_MAX_LEN = 4000;
const FEEDBACK_FORM_URL = "https://forms.gle/5r3j1uqK4YP7KWSA9";

export function createWorker(botConfig: BotConfig, bridge: ClaudeBridge, tunnelManager: TunnelManager): Bot {
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
  const pendingFreeText = new Map<
    number,
    { resolve: (answer: string) => void; timer: NodeJS.Timeout; question: string; msgId: number }
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
    "/resume — Resume a CLI session in Telegram\n" +
    "/cancel — Abort the current operation\n" +
    "/feedback — Send feedback or report an issue\n" +
    "/help — Show this help message\n\n" +
    "<b>Live Preview:</b>\n" +
    "/preview &lt;port&gt; — Open live preview tunnel to your dev server\n" +
    "/close — Close active preview tunnel\n\n" +
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

  bot.command("resume", async (ctx) => {
    const chatId = ctx.chat.id;
    const args = ctx.match?.toString().trim();

    if (args) {
      // Direct resume: /resume <session_id>
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(args)) {
        await ctx.reply("Invalid session ID format. Expected a UUID like: abc12345-1234-1234-1234-123456789abc");
        return;
      }

      const sessionFile = path.join(bridge.getProjectSessionsDir(), `${args}.jsonl`);
      if (!fs.existsSync(sessionFile)) {
        await ctx.reply("Session file not found. Make sure this session was created in the current project directory.");
        return;
      }

      if (bridge.isProcessing(chatId)) {
        bridge.cancelQuery(chatId);
      }

      bridge.setSessionId(chatId, args);
      await sendSessionHistory(chatId, args);
      await ctx.reply(`Session resumed: <code>${args}</code>\n\nSend a message to continue.`, { parse_mode: "HTML" });
    } else {
      // List recent sessions
      const sessions = bridge.listRecentSessions(8);
      if (sessions.length === 0) {
        await ctx.reply("No CLI sessions found for this project directory.");
        return;
      }

      const keyboard = new InlineKeyboard();
      for (const s of sessions) {
        const dateStr = s.modifiedAt.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
          ", " + s.modifiedAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
        const label = `${dateStr} — ${s.promptPreview}`;
        const truncatedLabel = label.length > 60 ? label.slice(0, 57) + "..." : label;
        keyboard.text(truncatedLabel, `resume:${s.sessionId}`).row();
      }

      await ctx.reply("Select a session to resume:", { reply_markup: keyboard });
    }
  });

  bot.command("feedback", async (ctx) => {
    await ctx.reply(
      "We'd love to hear from you!\n\n" +
        `<a href="${FEEDBACK_FORM_URL}">Open feedback form</a>`,
      { parse_mode: "HTML" }
    );
  });

  // --- Tunnel commands ---

  tunnelManager.setAutoCloseCallback(async (chatId, port) => {
    await bot.api.sendMessage(chatId, `Preview tunnel for port ${port} closed (30 min inactivity). Use /preview ${port} to reopen.`).catch(() => {});
  });

  bot.command("preview", async (ctx) => {
    const chatId = ctx.chat.id;
    const arg = ctx.match?.trim();

    if (!arg) {
      const info = tunnelManager.getTunnelInfo(chatId);
      if (info) {
        const keyboard = new InlineKeyboard().text("Close Preview", `tunnel:close:${chatId}`);
        await ctx.reply(`Active preview: ${info.url}\nPort: ${info.port}`, { reply_markup: keyboard });
      } else {
        await ctx.reply("Usage: /preview <port>\nExample: /preview 3000");
      }
      return;
    }

    const port = parsePort(arg);
    if (!port) {
      await ctx.reply("Invalid port. Examples:\n/preview 3000\n/preview localhost:3000\n/preview http://localhost:3000");
      return;
    }

    if (!config.NGROK_AUTH_TOKEN) {
      await ctx.reply("No ngrok token configured.\n\nRun `clautel setup` or set the NGROK_AUTH_TOKEN environment variable.\n\nGet a free token at: https://dashboard.ngrok.com/get-started/your-authtoken");
      return;
    }

    try {
      const url = await tunnelManager.openTunnel(chatId, port);
      const keyboard = new InlineKeyboard().text("Close Preview", `tunnel:close:${chatId}`);
      await ctx.reply(`Live preview: ${url}\n\nOpen this URL on your phone to see your dev server (port ${port}).`, { reply_markup: keyboard });
    } catch (err) {
      await ctx.reply(`Tunnel error: ${(err as Error).message}`);
    }
  });

  bot.command("close", async (ctx) => {
    const chatId = ctx.chat.id;
    const closed = await tunnelManager.closeTunnel(chatId);
    if (closed) {
      await ctx.reply("Preview tunnel closed.");
    } else {
      await ctx.reply("No active preview.");
    }
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
        await bot.api.sendMessage(chatId, "Claude is busy with a running task. Use /cancel to stop it first.");
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

      const onPlanApproval = async (planFileContent?: string): Promise<boolean> => {
        // Cancel any pending debounce edit so thinkingMsgId doesn't flash stale content
        if (editTimer) {
          clearTimeout(editTimer);
          editTimer = null;
        }

        // Save preamble before clearing buffer, then stabilise thinkingMsgId immediately
        const preamble = buffer.trim();
        buffer = "";
        currentActivity = "";
        await doEdit();

        // Combine preamble with the plan file Claude wrote
        const planBody = planFileContent?.trim() ?? "";
        const fullPlan = planBody || preamble;

        if (fullPlan) {
          const html = claudeToTelegram(fullPlan);
          const parts = splitMessage(html);
          for (const part of parts) {
            try {
              await bot.api.sendMessage(chatId, part, { parse_mode: "HTML" });
            } catch {
              await bot.api.sendMessage(chatId, part).catch(() => {});
            }
          }
        }

        currentActivity = "Waiting for plan approval...";

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
            keyboard.row();
          });
          keyboard.text("Other…", `answer:${requestId}:other`);

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

          answers[q.question] = answer;
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

  async function sendSessionHistory(chatId: number, sessionId: string): Promise<void> {
    try {
      const history = bridge.getSessionHistory(sessionId, 10);
      if (history.length === 0) return;

      let html = "<b>Conversation history:</b>\n\n";
      for (const entry of history) {
        if (entry.role === "user") {
          html += `<b>You:</b>\n${escapeHtml(entry.text)}\n\n`;
        } else {
          html += `<b>Claude:</b>\n${claudeToTelegram(entry.text)}\n\n`;
        }
      }

      const parts = splitMessage(html.trimEnd());
      for (const part of parts) {
        try {
          await bot.api.sendMessage(chatId, part, { parse_mode: "HTML" });
        } catch {
          await bot.api.sendMessage(chatId, part).catch(() => {});
        }
      }
    } catch {}
  }

  bot.on("message:text", (ctx) => {
    const chatId = ctx.chat.id;

    // Reset tunnel inactivity timer on any bot activity
    tunnelManager.resetTimer(chatId);

    // Check if waiting for a free-text answer to an AskUserQuestion
    const freeText = pendingFreeText.get(chatId);
    if (freeText) {
      clearTimeout(freeText.timer);
      pendingFreeText.delete(chatId);
      bot.api.editMessageText(chatId, freeText.msgId,
        `<b>${escapeHtml(freeText.question)}</b>\n\nAnswer: <b>${escapeHtml(ctx.message.text)}</b>`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      freeText.resolve(ctx.message.text);
      return;
    }

    const replyCtx = extractReplyContext(ctx);
    const prompt = replyCtx + ctx.message.text;
    logUser(ctx.message.text, tag);
    handlePrompt(chatId, prompt, (text) => ctx.reply(text));
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

  // Callback query handler for Approve/Deny, model selection, retry, browser
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Tunnel close
    if (data.startsWith("tunnel:close:")) {
      const chatId = Number(data.split(":")[2]);
      await ctx.answerCallbackQuery().catch(() => {});
      const closed = await tunnelManager.closeTunnel(chatId);
      const text = closed ? "Preview tunnel closed." : "No active preview.";
      await ctx.editMessageText(text).catch(() => {});
      return;
    }

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

    // Resume session selection
    const resumeMatch = data.match(/^resume:(.+)$/);
    if (resumeMatch) {
      const sessionId = resumeMatch[1];
      const chatId = ctx.chat!.id;

      if (bridge.isProcessing(chatId)) {
        bridge.cancelQuery(chatId);
      }

      bridge.setSessionId(chatId, sessionId);

      await ctx.editMessageText(
        `Session resumed: <code>${sessionId}</code>\n\nSend a message to continue.`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      await sendSessionHistory(chatId, sessionId);
      await ctx.answerCallbackQuery("Session resumed").catch(() => {});
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
      const optPart = parts[2];
      const pending = pendingAnswers.get(requestId);
      if (!pending) {
        await ctx.answerCallbackQuery("Request expired").catch(() => {});
        return;
      }

      if (optPart === "other") {
        // Move to free-text mode: clear options timer, wait for next message
        clearTimeout(pending.timer);
        pendingAnswers.delete(requestId);
        await ctx.answerCallbackQuery("Type your answer").catch(() => {});
        await ctx.editMessageText(
          `<b>${escapeHtml(pending.question)}</b>\n\nType your answer:`,
          { parse_mode: "HTML" }
        ).catch(() => {});
        const chatId = ctx.chat!.id;
        const sentMsg = await bot.api.sendMessage(chatId, "Send your reply now…");
        const timer = setTimeout(() => {
          pendingFreeText.delete(chatId);
          bot.api.editMessageText(chatId, sentMsg.message_id, "Timed out waiting for answer.").catch(() => {});
          pending.resolve("");
        }, APPROVAL_TIMEOUT_MS);
        pendingFreeText.set(chatId, { resolve: pending.resolve, timer, question: pending.question, msgId: sentMsg.message_id });
        return;
      }

      const optIdx = Number(optPart);
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
