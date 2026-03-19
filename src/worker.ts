import fs from "node:fs";
import path from "node:path";
import { Bot, InlineKeyboard, Context } from "grammy";
import { config, DATA_DIR } from "./config.js";
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
import { checkLicenseForQuery, getPaymentUrl, detectClaudePlan, getLicensePlan } from "./license.js";
import { ScheduleManager, parseScheduleWithClaude, generateScheduleId } from "./scheduler.js";
import type { Schedule } from "./scheduler.js";

const CONFIG_FILE = path.join(DATA_DIR, "config.json");

const TYPING_INTERVAL_MS = 4000;
const EDIT_DEBOUNCE_MS = 1500;
const DRAFT_DEBOUNCE_MS = 300; // Faster updates for sendMessageDraft (no flicker)
const APPROVAL_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours — users interact async on mobile
const FETCH_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

async function downloadTelegramFile(token: string, filePath: string): Promise<Buffer> {
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Telegram file download failed: HTTP ${res.status}`);

  const contentLength = Number(res.headers.get("content-length") || 0);
  if (contentLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`File too large (${(contentLength / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`File too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`);
  }
  return buffer;
}
const REPLY_PREVIEW_MAX = 500;
const STREAM_MAX_LEN = 4000;
const FEEDBACK_FORM_URL = "https://forms.gle/5r3j1uqK4YP7KWSA9";
const NGROK_SETUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to paste ngrok token

export function createWorker(botConfig: BotConfig, bridge: ClaudeBridge, tunnelManager: TunnelManager, scheduleManager: ScheduleManager): Bot {
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
  const pendingNgrokSetup = new Map<number, { port: number; timer: NodeJS.Timeout }>();
  const pendingScheduleConfirm = new Map<number, { schedule: Omit<Schedule, "id" | "createdAt" | "lastRunAt">; timer: NodeJS.Timeout }>();
  let approvalCounter = 0;
  let retryCounter = 0;

  // Message queue for handling concurrent requests
  interface QueuedMessage {
    prompt: string;
    replyFn: (text: string) => Promise<{ message_id: number }>;
    senderTag?: string;
  }

  const messageQueues = new Map<number, QueuedMessage[]>();
  const MAX_QUEUE_SIZE = 20;

  function enqueueMessage(chatId: number, item: QueuedMessage): number {
    let queue = messageQueues.get(chatId);
    if (!queue) {
      queue = [];
      messageQueues.set(chatId, queue);
    }
    queue.push(item);
    return queue.length;
  }

  function dequeueMessage(chatId: number): QueuedMessage | undefined {
    const queue = messageQueues.get(chatId);
    if (!queue || queue.length === 0) return undefined;
    const item = queue.shift()!;
    if (queue.length === 0) messageQueues.delete(chatId);
    return item;
  }

  function clearQueue(chatId: number): number {
    const queue = messageQueues.get(chatId);
    if (!queue) return 0;
    const count = queue.length;
    messageQueues.delete(chatId);
    return count;
  }

  function saveNgrokToken(token: string): void {
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[${tag}] Failed to parse config file, not saving ngrok token:`, error);
        return;
      }
    }
    existing.NGROK_AUTH_TOKEN = token;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 });
  }

  bot.catch((err) => {
    console.error(`[${tag}] Bot error:`, err.message);
  });

  // Cache owner-in-group check to avoid hitting Telegram API on every message
  const ownerInGroupCache = new Map<number, { result: boolean; checkedAt: number }>();
  const OWNER_CHECK_TTL_MS = 5 * 60 * 1000; // 5 minutes for positive results
  const OWNER_CHECK_NEG_TTL_MS = 30 * 1000; // 30 seconds for negative results (owner may rejoin)

  async function isOwnerInGroup(chatId: number): Promise<boolean> {
    const cached = ownerInGroupCache.get(chatId);
    const ttl = cached?.result ? OWNER_CHECK_TTL_MS : OWNER_CHECK_NEG_TTL_MS;
    if (cached && Date.now() - cached.checkedAt < ttl) return cached.result;
    try {
      const member = await bot.api.getChatMember(chatId, config.TELEGRAM_OWNER_ID);
      const result = ["creator", "administrator", "member"].includes(member.status);
      ownerInGroupCache.set(chatId, { result, checkedAt: Date.now() });
      return result;
    } catch {
      ownerInGroupCache.set(chatId, { result: false, checkedAt: Date.now() });
      return false;
    }
  }

  // Auth guard — private: owner-only; group: Max plan + owner must be in group
  bot.use(async (ctx, next) => {
    const chatType = ctx.chat?.type;
    if (chatType === "private") {
      if (ctx.from?.id !== config.TELEGRAM_OWNER_ID) {
        await ctx.reply("Unauthorized.");
        return;
      }
    } else if (chatType === "group" || chatType === "supergroup") {
      if (getLicensePlan() !== "max") {
        return; // Only Max plan supports group chats — silently ignore
      }
      if (!await isOwnerInGroup(ctx.chat!.id)) {
        return; // Owner not in this group — silently ignore
      }
    } else {
      return; // channels, unknown — silently ignore
    }
    await next();
  });

  function getSenderTag(ctx: Context): string | undefined {
    if (ctx.chat?.type === "private") return undefined;
    const from = ctx.from;
    if (!from) return undefined;
    return from.username ? `@${from.username}` : (from.first_name || `user:${from.id}`);
  }

  const repoName = path.basename(botConfig.workingDir);

  const helpText =
    `<b>${escapeHtml(repoName)}</b>\n` +
    `<code>${escapeHtml(botConfig.workingDir)}</code>\n\n` +
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
    "/preview [port] — Start dev server and open live preview\n" +
    "/close — Close active preview tunnel\n\n" +
    "<b>Features:</b>\n" +
    "• Send documents (PDF, code files, etc.) for analysis\n" +
    "• Reply to any Claude message to include it as context\n" +
    "• Tap Retry on errors to re-run the last prompt\n\n" +
    "<b>Group Chat (Max plan):</b>\n" +
    "• Add this bot to a group where you're a member\n" +
    "• Everyone in the group can send prompts to Claude\n" +
    "• Messages are tagged with the sender's name for context\n\n" +
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
    const queueCleared = clearQueue(chatId);
    bridge.clearSession(chatId);
    const extra = queueCleared > 0 ? ` ${queueCleared} queued message(s) discarded.` : "";
    await ctx.reply(`Session cleared.${extra} Send a message to start fresh.`);
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
    const chatId = ctx.chat.id;
    const wasProcessing = bridge.cancelQuery(chatId);
    const queueCleared = clearQueue(chatId);
    if (wasProcessing || queueCleared > 0) {
      const parts: string[] = [];
      if (wasProcessing) parts.push("Operation cancelled");
      if (queueCleared > 0) parts.push(`${queueCleared} queued message(s) discarded`);
      await ctx.reply(parts.join(". ") + ".");
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

  // --- Schedule commands ---

  const SCHEDULE_CONFIRM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to confirm

  bot.command("schedule", async (ctx) => {
    const chatId = ctx.chat.id;
    const input = ctx.match?.trim();

    if (!input) {
      await ctx.reply(
        "<b>Schedule a recurring task</b>\n\n" +
          "Send a natural language description, for example:\n" +
          "<code>/schedule daily 9am run tests and fix any failures</code>\n" +
          "<code>/schedule every monday write changelog from last week's commits</code>\n" +
          "<code>/schedule every 6 hours check for new dependency vulnerabilities</code>",
        { parse_mode: "HTML" }
      );
      return;
    }

    await ctx.reply("Parsing schedule...");

    const parsed = await parseScheduleWithClaude(input);
    if (!parsed) {
      await ctx.reply("Could not parse schedule. Try being more specific, e.g. <code>/schedule daily 9am run tests</code>", { parse_mode: "HTML" });
      return;
    }

    const timer = setTimeout(() => {
      pendingScheduleConfirm.delete(chatId);
      bot.api.sendMessage(chatId, "Schedule confirmation timed out. Send /schedule to try again.").catch(() => {});
    }, SCHEDULE_CONFIRM_TIMEOUT_MS);

    pendingScheduleConfirm.set(chatId, {
      schedule: {
        botId: botConfig.id,
        chatId,
        prompt: parsed.prompt,
        cronExpr: parsed.cronExpr,
        humanLabel: parsed.humanLabel,
      },
      timer,
    });

    const keyboard = new InlineKeyboard()
      .text("Confirm", `schedule:confirm:${chatId}`)
      .text("Cancel", `schedule:cancel:${chatId}`);

    await ctx.reply(
      "<b>Confirm schedule</b>\n\n" +
        `<b>When:</b> ${escapeHtml(parsed.humanLabel)}\n` +
        `<b>Task:</b> ${escapeHtml(parsed.prompt)}\n\n` +
        "<i>Scheduled tasks run automatically without approval prompts.</i>",
      { parse_mode: "HTML", reply_markup: keyboard }
    );
  });

  bot.command("schedules", async (ctx) => {
    const schedules = scheduleManager.getForBot(botConfig.id);
    if (schedules.length === 0) {
      await ctx.reply("No scheduled tasks. Use /schedule to add one.");
      return;
    }

    const lines = schedules.map((s, i) => {
      const lastRun = s.lastRunAt
        ? `Last run: ${new Date(s.lastRunAt).toLocaleString()}`
        : "Never run";
      return `<b>[${i + 1}]</b> ${escapeHtml(s.humanLabel)}\n${escapeHtml(s.prompt)}\n<i>${lastRun}</i>`;
    });

    await ctx.reply(
      `<b>Scheduled tasks for ${escapeHtml(repoName)}</b>\n\n` +
        lines.join("\n\n") +
        "\n\nUse /unschedule &lt;number&gt; to remove.",
      { parse_mode: "HTML" }
    );
  });

  bot.command("unschedule", async (ctx) => {
    const arg = ctx.match?.trim();
    if (!arg) {
      await ctx.reply("Usage: <code>/unschedule &lt;number&gt;</code>\n\nUse /schedules to see the list.", { parse_mode: "HTML" });
      return;
    }

    const schedules = scheduleManager.getForBot(botConfig.id);
    const idx = parseInt(arg, 10) - 1;

    if (isNaN(idx) || idx < 0 || idx >= schedules.length) {
      await ctx.reply(`Invalid number. Use /schedules to see the list.`);
      return;
    }

    const schedule = schedules[idx];
    scheduleManager.remove(schedule.id);
    await ctx.reply(`Removed: <b>${escapeHtml(schedule.humanLabel)}</b>`, { parse_mode: "HTML" });
  });

  // --- Tunnel commands ---

  tunnelManager.setAutoCloseCallback(async (chatId, port) => {
    await bot.api.sendMessage(chatId, `Preview tunnel for port ${port} closed (30 min inactivity). Use /preview to reopen.`).catch(() => {});
  });

  async function openTunnelAndNotify(chatId: number, port: number): Promise<void> {
    try {
      const url = await tunnelManager.openTunnel(chatId, port);
      const keyboard = new InlineKeyboard().text("Close Preview", `tunnel:close:${chatId}`);
      await bot.api.sendMessage(
        chatId,
        `Live preview: ${url}\n\nPort ${port}. Open on your phone!`,
        { reply_markup: keyboard }
      );
    } catch (err) {
      await bot.api.sendMessage(chatId, `Tunnel error: ${(err as Error).message}`);
    }
  }

  const PREVIEW_PROMPT =
    "Start the dev server for this project. Install any missing dependencies if needed. " +
    "If you encounter errors, fix them and retry.\n\n" +
    "Once the server is running, expose it publicly using ngrok. " +
    "Install ngrok CLI if it's not already installed (e.g. `brew install ngrok` or `npm install -g ngrok`). " +
    `The ngrok auth token is stored in the NGROK_AUTH_TOKEN environment variable or in the project's config file at ${CONFIG_FILE}.\n\n` +
    "Run: ngrok http <PORT> (where PORT is the dev server port).\n" +
    "Share the public ngrok URL in your response so I can open it on my phone.";

  bot.command("preview", async (ctx) => {
    const chatId = ctx.chat.id;
    const arg = ctx.match?.trim();

    // Explicit port: bot opens ngrok tunnel directly (fast, no Claude needed)
    if (arg) {
      // Check ngrok token for direct tunnel
      if (!config.NGROK_AUTH_TOKEN) {
        const timer = setTimeout(() => {
          pendingNgrokSetup.delete(chatId);
        }, NGROK_SETUP_TIMEOUT_MS);
        pendingNgrokSetup.set(chatId, { port: parsePort(arg) || 0, timer });
        await ctx.reply(
          "To use live preview, you need an ngrok auth token.\n\n" +
          "1. Sign up at https://ngrok.com (free)\n" +
          "2. Copy your token from: https://dashboard.ngrok.com/get-started/your-authtoken\n\n" +
          "Paste your token here:"
        );
        return;
      }

      const port = parsePort(arg);
      if (!port) {
        await ctx.reply("Invalid port. Examples:\n/preview 3000\n/preview localhost:3000");
        return;
      }
      await openTunnelAndNotify(chatId, port);
      return;
    }

    // No port: Claude starts the dev server and sets up ngrok
    logUser("[preview] auto-start dev server + ngrok", tag);
    handlePrompt(chatId, PREVIEW_PROMPT, (text) => ctx.reply(text));
  });

  bot.command("close", async (ctx) => {
    const chatId = ctx.chat.id;
    const closed = await tunnelManager.closeTunnel(chatId);
    if (closed) {
      await ctx.reply("Preview tunnel closed.");
    } else {
      await ctx.reply("No active preview. If Claude started ngrok, tell Claude to stop it.");
    }
  });

  function handlePrompt(chatId: number, prompt: string, replyFn: (text: string) => Promise<{ message_id: number }>, senderTag?: string) {
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
        const queue = messageQueues.get(chatId);
        if (queue && queue.length >= MAX_QUEUE_SIZE) {
          await bot.api.sendMessage(chatId, "Queue full — please wait for current tasks to finish.");
          return;
        }
        const position = enqueueMessage(chatId, { prompt, replyFn, senderTag });
        await bot.api.sendMessage(chatId, `Queued (position #${position}). Will process when current task finishes.`);
        return;
      }

      // Apply sender attribution for group chats
      const effectivePrompt = senderTag ? `[from ${senderTag}]: ${prompt}` : prompt;

      bridge.setLastPrompt(chatId, prompt);

      await bot.api.sendChatAction(chatId, "typing");

      // Draft streaming state
      let draftId = 1;
      let draftSupported = true;
      let draftActive = false;
      let thinkingMsgId: number | null = null;

      // Try sendMessageDraft first (smooth animated streaming, DM-only)
      try {
        await bot.api.sendMessageDraft(chatId, draftId, "Thinking...");
        draftActive = true;
      } catch {
        // Draft not supported (group chat, old client) — fall back to editMessageText
        draftSupported = false;
        const thinking = await replyFn("Thinking...");
        thinkingMsgId = thinking.message_id;
      }

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

        // Build plain text content (used for drafts and as fallback)
        const plainFooter = currentActivity ? `\n\n${currentActivity}` : "";
        let plainContent: string;
        if (buffer.trim()) {
          const maxLen = STREAM_MAX_LEN - plainFooter.length;
          const text = buffer.length > maxLen ? buffer.slice(0, maxLen) + "\n\n... streaming ..." : buffer;
          plainContent = text + plainFooter;
        } else {
          plainContent = (plainFooter.trim() || "Thinking...").trim();
        }

        if (!plainContent.trim() || plainContent === lastEditedText) return;
        lastEditedText = plainContent;

        // Draft path: smooth animated streaming via sendMessageDraft
        if (draftSupported && draftActive) {
          try {
            await bot.api.sendMessageDraft(chatId, draftId, plainContent);
            return;
          } catch {
            // Draft failed mid-stream — fall back permanently for this request
            draftSupported = false;
            draftActive = false;
            const msg = await replyFn(plainContent);
            thinkingMsgId = msg.message_id;
            return;
          }
        }

        // Fallback path: editMessageText with HTML
        if (!thinkingMsgId) return;
        const htmlFooter = currentActivity ? `\n\n<i>${escapeHtml(currentActivity)}</i>` : "";
        let htmlContent: string;
        if (buffer.trim()) {
          let html = claudeToTelegram(buffer);
          const maxLen = STREAM_MAX_LEN - htmlFooter.length;
          if (html.length > maxLen) {
            html = html.slice(0, maxLen) + "\n\n<i>... streaming ...</i>";
          }
          htmlContent = html + htmlFooter;
        } else {
          htmlContent = htmlFooter.trim() || "<i>Thinking...</i>";
        }

        try {
          await bot.api.editMessageText(chatId, thinkingMsgId, htmlContent, {
            parse_mode: "HTML",
          });
        } catch {
          try {
            await bot.api.editMessageText(chatId, thinkingMsgId, plainContent);
          } catch {}
        }
      };

      const scheduleEdit = () => {
        const debounce = (draftSupported && draftActive) ? DRAFT_DEBOUNCE_MS : EDIT_DEBOUNCE_MS;
        const now = Date.now();
        if (now - lastEditTime >= debounce) {
          doEdit();
        } else if (!editTimer) {
          editTimer = setTimeout(doEdit, debounce - (now - lastEditTime));
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

        // Save preamble before clearing buffer
        const preamble = buffer.trim();
        buffer = "";
        currentActivity = "";

        // Clear display before sending plan as real messages
        if (draftActive) {
          await bot.api.sendMessageDraft(chatId, draftId, " ").catch(() => {});
        } else {
          await doEdit();
        }

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

        const approved = await new Promise<boolean>((resolve) => {
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

        // Fresh draft ID for the next streaming segment after approval
        if (draftActive) draftId++;
        return approved;
      };

      const onAskUser = async (questions: AskUserQuestion[]): Promise<Record<string, string>> => {
        // Pause streaming: cancel pending edits and clear draft ghost bubble
        // so it doesn't overwrite the inline keyboard buttons
        if (editTimer) { clearTimeout(editTimer); editTimer = null; }
        if (draftActive) {
          await bot.api.sendMessageDraft(chatId, draftId, " ").catch(() => {});
        }

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

        // Fresh draft ID for the next streaming segment after answers
        if (draftActive) draftId++;
        return answers;
      };

      const onToolApproval = async (
        toolName: string,
        input: Record<string, unknown>
      ): Promise<"allow" | "always" | "deny"> => {
        // Pause streaming: cancel pending edits and clear draft ghost bubble
        // so it doesn't overwrite the inline keyboard buttons
        if (editTimer) { clearTimeout(editTimer); editTimer = null; }
        if (draftActive) {
          await bot.api.sendMessageDraft(chatId, draftId, " ").catch(() => {});
        }

        const result = await new Promise<"allow" | "always" | "deny">((resolve) => {
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

        // Fresh draft ID for the next streaming segment after approval
        if (draftActive) draftId++;
        return result;
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

        if (draftActive) {
          // Clear the draft ghost bubble before sending real messages
          await bot.api.sendMessageDraft(chatId, draftId, " ").catch(() => {});
          draftActive = false;
        } else if (thinkingMsgId) {
          try {
            await bot.api.deleteMessage(chatId, thinkingMsgId);
          } catch {
            await bot.api
              .editMessageText(chatId, thinkingMsgId, "⏤")
              .catch(() => {});
          }
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

        if (draftActive) {
          // Clear draft ghost, then send error as a new message (drafts can't have keyboards)
          await bot.api.sendMessageDraft(chatId, draftId, " ").catch(() => {});
          draftActive = false;
          await bot.api.sendMessage(chatId, `Error: ${error.message}`, {
            reply_markup: keyboard,
          }).catch(() => {});
        } else if (thinkingMsgId) {
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
        } else {
          await bot.api.sendMessage(chatId, `Error: ${error.message}`, {
            reply_markup: keyboard,
          }).catch(() => {});
        }
      };

      await bridge.sendMessage(chatId, effectivePrompt, {
        onStreamChunk,
        onStatusUpdate,
        onToolApproval,
        onAskUser,
        onPlanApproval,
        onResult,
        onError,
        onSessionReset: () => {
          bot.api.sendMessage(chatId, "Previous session not found. Starting a fresh session.").catch(() => {});
        },
      });

      // Runs if cancelled (onResult/onError were never called)
      if (!responseHandled) {
        clearInterval(typingInterval);
        if (editTimer) clearTimeout(editTimer);
        if (draftActive) {
          // Clear draft ghost, then send "Cancelled." as a real message
          await bot.api.sendMessageDraft(chatId, draftId, " ").catch(() => {});
          await bot.api.sendMessage(chatId, "Cancelled.").catch(() => {});
        } else if (thinkingMsgId) {
          try {
            await bot.api.deleteMessage(chatId, thinkingMsgId);
          } catch {
            await bot.api.editMessageText(chatId, thinkingMsgId, "Cancelled.").catch(() => {});
          }
        }
      }

      // Drain queue — process next message if any
      const nextItem = dequeueMessage(chatId);
      if (nextItem) {
        handlePrompt(chatId, nextItem.prompt, nextItem.replyFn, nextItem.senderTag);
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

    // Check if waiting for ngrok auth token
    const ngrokSetup = pendingNgrokSetup.get(chatId);
    if (ngrokSetup) {
      clearTimeout(ngrokSetup.timer);
      pendingNgrokSetup.delete(chatId);
      const token = ctx.message.text.trim();
      if (!token) {
        ctx.reply("No token provided. Use /preview <port> to try again.").catch(() => {});
        return;
      }

      // Save token and proceed
      tunnelManager.setAuthToken(token);
      saveNgrokToken(token);
      config.NGROK_AUTH_TOKEN = token;
      (async () => {
        await bot.api.sendMessage(chatId, "Token saved!");
        if (ngrokSetup.port) {
          // Explicit port was given before token prompt
          await openTunnelAndNotify(chatId, ngrokSetup.port);
        } else {
          // No port — Claude starts the dev server + ngrok
          handlePrompt(chatId, PREVIEW_PROMPT, (text) => bot.api.sendMessage(chatId, text));
        }
      })().catch(() => {});
      return;
    }

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
    handlePrompt(chatId, prompt, (text) => ctx.reply(text), getSenderTag(ctx));
  });

  bot.on("message:document", async (ctx) => {
    const chatId = ctx.chat.id;

    const doc = ctx.message.document;
    if (doc.file_size && doc.file_size > MAX_DOWNLOAD_BYTES) {
      await ctx.reply(`File too large (${(doc.file_size / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`);
      return;
    }

    const file = await ctx.api.getFile(doc.file_id);
    if (!file.file_path) {
      await ctx.reply("Error: Could not get file path from Telegram.");
      return;
    }

    const tmpDir = bridge.getTempDir();
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const rawName = doc.file_name || `file-${Date.now()}`;
    const fileName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_");
    const tmpFile = path.join(tmpDir, fileName);

    let arrayBuf: Buffer;
    try {
      arrayBuf = await downloadTelegramFile(botConfig.token, file.file_path);
    } catch (err) {
      await ctx.reply((err as Error).message);
      return;
    }
    fs.writeFileSync(tmpFile, arrayBuf, { mode: 0o600 });

    const caption = ctx.message.caption || `Analyze this file: ${fileName}`;
    logUser(`[document: ${fileName}] ${caption}`, tag);
    const replyCtx = extractReplyContext(ctx);
    const prompt = replyCtx + `I've sent you a file saved at ${tmpFile}\n\nPlease read that file, then respond to this: ${caption}`;

    handlePrompt(chatId, prompt, (text) => ctx.reply(text), getSenderTag(ctx));
  });

  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;

    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    if (photo.file_size && photo.file_size > MAX_DOWNLOAD_BYTES) {
      await ctx.reply(`Photo too large (${(photo.file_size / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`);
      return;
    }

    const file = await ctx.api.getFile(photo.file_id);
    if (!file.file_path) {
      await ctx.reply("Error: Could not get file path from Telegram.");
      return;
    }

    const tmpDir = bridge.getTempDir();
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const ext = path.extname(file.file_path || ".jpg") || ".jpg";
    const tmpFile = path.join(tmpDir, `tg-${Date.now()}${ext}`);

    let arrayBuf: Buffer;
    try {
      arrayBuf = await downloadTelegramFile(botConfig.token, file.file_path);
    } catch (err) {
      await ctx.reply((err as Error).message);
      return;
    }
    fs.writeFileSync(tmpFile, arrayBuf, { mode: 0o600 });

    const caption = ctx.message.caption || "Describe this image.";
    logUser(`[photo] ${caption}`, tag);
    const replyCtx = extractReplyContext(ctx);
    const prompt = replyCtx + `I've sent you an image saved at ${tmpFile}\n\nPlease read/view that image file, then respond to this: ${caption}`;

    handlePrompt(chatId, prompt, (text) => ctx.reply(text), getSenderTag(ctx));
  });

  // Callback query handler for Approve/Deny, model selection, retry, browser
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Schedule confirm/cancel
    if (data.startsWith("schedule:confirm:") || data.startsWith("schedule:cancel:")) {
      const parts = data.split(":");
      const action = parts[1];
      const chatId = Number(parts[2]);
      const pending = pendingScheduleConfirm.get(chatId);

      if (!pending) {
        await ctx.answerCallbackQuery("Confirmation expired").catch(() => {});
        return;
      }

      clearTimeout(pending.timer);
      pendingScheduleConfirm.delete(chatId);

      if (action === "cancel") {
        await ctx.editMessageText("Schedule cancelled.").catch(() => {});
        await ctx.answerCallbackQuery("Cancelled").catch(() => {});
        return;
      }

      const schedule: Schedule = {
        ...pending.schedule,
        id: generateScheduleId(),
        createdAt: new Date().toISOString(),
        lastRunAt: null,
      };

      scheduleManager.add(schedule);

      await ctx.editMessageText(
        `<b>Schedule saved</b>\n\n` +
          `<b>When:</b> ${escapeHtml(schedule.humanLabel)}\n` +
          `<b>Task:</b> ${escapeHtml(schedule.prompt)}\n\n` +
          `Use /schedules to view or /unschedule to remove.`,
        { parse_mode: "HTML" }
      ).catch(() => {});
      await ctx.answerCallbackQuery("Schedule saved").catch(() => {});
      return;
    }

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
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(sessionId)) {
        await ctx.answerCallbackQuery("Invalid session ID").catch(() => {});
        return;
      }
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
