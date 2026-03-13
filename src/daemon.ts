import fs from "node:fs";
import path from "node:path";
import { Bot } from "grammy";
import { ClaudeBridge } from "./claude.js";
import { createManager } from "./manager.js";
import { createWorker } from "./worker.js";
import { loadBots, addBot, removeBot } from "./store.js";
import type { BotConfig } from "./store.js";
import { DATA_DIR, config } from "./config.js";
import { TunnelManager } from "./tunnel.js";
import { ScheduleManager, loadSchedules } from "./scheduler.js";
import { claudeToTelegram, splitMessage } from "./formatter.js";

import { checkLicenseForStartup, startPeriodicValidation, flushLicenseSync, getPaymentUrl, detectClaudePlan, getPlanLabel } from "./license.js";

const PID_FILE = path.join(DATA_DIR, "daemon.pid");
const HEALTH_CHECK_INTERVAL_MS = 5 * 60_000; // 5 minutes — grammY handles transient reconnects internally

const activeWorkers = new Map<number, { config: BotConfig; bot: Bot; bridge: ClaudeBridge; tunnelManager: TunnelManager }>();
let scheduleManager: ScheduleManager;
const lastWorkerError = new Map<number, number>(); // botId → timestamp of last polling error
const RESTART_COOLDOWN_MS = 120_000; // wait 2 minutes before restarting a failed worker
let healthCheckTimer: NodeJS.Timeout | null = null;
let licenseTimer: NodeJS.Timeout | null = null;

const WORKER_COMMANDS = [
  { command: "new",        description: "Start a fresh session" },
  { command: "model",      description: "Switch Claude model (Opus / Sonnet / Haiku)" },
  { command: "cost",       description: "Show token usage for this session" },
  { command: "session",    description: "Get session ID to resume in CLI" },
  { command: "resume",     description: "Resume a CLI session in Telegram" },
  { command: "cancel",     description: "Abort the current operation" },
  { command: "feedback",   description: "Send feedback or report an issue" },
  { command: "help",       description: "Show help" },
  { command: "preview",    description: "Open live preview tunnel to your dev server" },
  { command: "close",      description: "Close active preview tunnel" },
  { command: "schedule",   description: "Add a scheduled task" },
  { command: "schedules",  description: "List scheduled tasks" },
  { command: "unschedule", description: "Remove a scheduled task" },
];

const MANAGER_COMMANDS = [
  { command: "bots",         description: "List active worker bots" },
  { command: "add",          description: "Add a new worker bot" },
  { command: "remove",       description: "Remove a worker bot (or 'all')" },
  { command: "subscribe",    description: "Get a license or upgrade" },
  { command: "subscription", description: "View license, billing & cancel" },
  { command: "schedules",    description: "View all scheduled tasks across bots" },
  { command: "feedback",     description: "Send feedback or report an issue" },
  { command: "cancel",       description: "Cancel current operation" },
  { command: "help",         description: "Show help" },
];

async function startWorker(botConfig: BotConfig): Promise<void> {
  const bridge = new ClaudeBridge(botConfig.id, botConfig.workingDir, botConfig.username);
  const tunnelManager = new TunnelManager(config.NGROK_AUTH_TOKEN);
  const bot = createWorker(botConfig, bridge, tunnelManager, scheduleManager);

  await bot.init();
  await bot.api.setMyCommands(WORKER_COMMANDS);

  addBot(botConfig);
  activeWorkers.set(botConfig.id, { config: botConfig, bot, bridge, tunnelManager });

  // Fire-and-forget: polling runs in background with 409 retry logic.
  // When a previous instance's getUpdates long-poll is still alive (up to 30s timeout),
  // Telegram returns 409 Conflict. We retry with backoff, waiting long enough for it to expire.
  const startPolling = async () => {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 15_000; // 15s × 1, 15s × 2 = 45s total window (> 30s poll timeout)
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await bot.start();
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("409") && attempt < MAX_RETRIES) {
          const wait = RETRY_DELAY_MS * attempt;
          console.log(`[${botConfig.username}] 409 Conflict (attempt ${attempt}/${MAX_RETRIES}), retrying in ${wait / 1000}s...`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
    }
  };

  console.log(`Worker started: @${botConfig.username} → ${botConfig.workingDir}`);
  startPolling().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${botConfig.username}] Polling error:`, msg);
    bridge.abortAll();
    try { bot.stop(); } catch {}
    activeWorkers.delete(botConfig.id);
    lastWorkerError.set(botConfig.id, Date.now());
  });
}

async function stopWorker(botId: number): Promise<void> {
  const worker = activeWorkers.get(botId);
  if (!worker) return;

  worker.bridge.abortAll();
  scheduleManager.removeAllForBot(botId);
  await worker.tunnelManager.closeAll();
  await worker.bot.stop();
  activeWorkers.delete(botId);
  removeBot(botId);

  console.log(`Worker stopped: @${worker.config.username}`);
}

function getActiveWorkers(): Map<number, { config: BotConfig }> {
  const result = new Map<number, { config: BotConfig }>();
  for (const [id, w] of activeWorkers) {
    result.set(id, { config: w.config });
  }
  return result;
}

async function main() {
  // Write our own PID so the CLI can detect us even if launched via npm start
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PID_FILE, String(process.pid));

  // Initialize schedule manager
  scheduleManager = new ScheduleManager(async (botId, chatId, prompt, scheduleId) => {
    const worker = activeWorkers.get(botId);
    if (!worker) {
      console.error(`[scheduler] Worker ${botId} not found for schedule ${scheduleId}`);
      return;
    }
    worker.bridge.clearSession(chatId);
    await worker.bridge.sendMessage(chatId, prompt, {
      onResult: async (result) => {
        const text = result.text || "Task completed.";
        const html = claudeToTelegram(text);
        const parts = splitMessage(html);
        for (const part of parts) {
          try {
            await worker.bot.api.sendMessage(chatId, `<b>Scheduled task done</b>\n\n${part}`, { parse_mode: "HTML" });
          } catch {
            await worker.bot.api.sendMessage(chatId, part).catch(() => {});
          }
        }
      },
      onError: async (err) => {
        await worker.bot.api.sendMessage(chatId, `Scheduled task failed: ${err.message}`).catch(() => {});
      },
      onStreamChunk: () => {},
      onStatusUpdate: () => {},
      onToolApproval: async () => "allow",
      onAskUser: async () => ({}),
      onPlanApproval: async () => true,
      onSessionReset: () => {},
    }, "bypassPermissions", 25);
  });

  // Detect Claude plan
  const { tier } = detectClaudePlan();
  console.log(`Detected Claude plan: ${getPlanLabel(tier)}`);

  // License gate — daemon won't start without a valid license
  const startupCheck = await checkLicenseForStartup();
  if (!startupCheck.allowed) {
    console.error(`License: ${startupCheck.reason}`);
    console.error(`Purchase: ${getPaymentUrl(tier)}`);
    console.error(`Activate: clautel activate <key>`);
    fs.rmSync(PID_FILE, { force: true });
    process.exit(1);
  }
  if (startupCheck.warning) {
    console.warn(`License warning: ${startupCheck.warning}`);
  }
  licenseTimer = startPeriodicValidation();

  const managerBot = createManager({ startWorker, stopWorker, getActiveWorkers });

  // Exit immediately if another instance is already polling this token
  managerBot.catch((err) => {
    if (err.message.includes("409: Conflict")) {
      console.error("Another daemon is already running. Stop it first: clautel stop");
    } else {
      console.error("[manager] Error:", err.message);
    }
    shutdown();
  });

  await managerBot.api.setMyCommands(MANAGER_COMMANDS);

  // Restore saved workers from previous session
  const savedBots = loadBots();
  for (const botConfig of savedBots) {
    try {
      await startWorker(botConfig);
    } catch (err) {
      console.error(`Failed to restore worker @${botConfig.username}:`, err);
    }
  }

  // Restore scheduled tasks
  scheduleManager.start(loadSchedules());

  // Periodic health check: restart dead workers and recover saved bots
  healthCheckTimer = setInterval(async () => {
    // 1. Check running workers are still reachable
    const deadConfigs: BotConfig[] = [];
    for (const [id, worker] of activeWorkers) {
      try {
        await worker.bot.api.getMe();
      } catch (err) {
        console.error(`[${worker.config.username}] Health check failed, will restart: ${(err as Error).message}`);
        deadConfigs.push(worker.config);
        worker.bridge.abortAll();
        try { await worker.bot.stop(); } catch {}
        activeWorkers.delete(id);
      }
    }

    // 2. Restart workers that just failed
    for (const config of deadConfigs) {
      try {
        await startWorker(config);
        console.log(`[${config.username}] Restarted after health check failure`);
      } catch (err) {
        console.error(`[${config.username}] Restart failed: ${(err as Error).message}`);
      }
    }

    // 3. Start any saved bots that aren't currently running (e.g. from polling errors, previous crash)
    const savedBots = loadBots();
    for (const botConfig of savedBots) {
      if (!activeWorkers.has(botConfig.id)) {
        // Respect cooldown to prevent rapid restart loops (409 Conflict cycles)
        const lastError = lastWorkerError.get(botConfig.id);
        if (lastError && Date.now() - lastError < RESTART_COOLDOWN_MS) {
          continue;
        }
        try {
          await startWorker(botConfig);
          lastWorkerError.delete(botConfig.id);
          console.log(`[${botConfig.username}] Recovered from saved config`);
        } catch (err) {
          console.error(`[${botConfig.username}] Recovery failed: ${(err as Error).message}`);
          lastWorkerError.set(botConfig.id, Date.now());
        }
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  // Start manager bot polling with 409 retry logic.
  // When launchd restarts the daemon after a crash, the previous Telegram
  // long-poll session may still be alive for up to 30s → 409 Conflict.
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 15_000; // 15s × 1, 15s × 2 = 45s total window (> 30s poll timeout)
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await managerBot.start({
        onStart: (info) => {
          console.log(`Manager bot: @${info.username}`);
          console.log(`Active workers: ${activeWorkers.size}`);
          console.log(`\nReady! DM @${info.username} to manage bots`);
        },
      });
      break; // bot.start() resolved means bot stopped gracefully
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("409") && attempt < MAX_RETRIES) {
        const wait = RETRY_DELAY_MS * attempt;
        console.log(`[manager] 409 Conflict (attempt ${attempt}/${MAX_RETRIES}), retrying in ${wait / 1000}s...`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err; // non-409 or final attempt — let main().catch() handle it
    }
  }
}

const shutdown = async () => {
  console.log("\nShutting down...");
  if (licenseTimer) clearInterval(licenseTimer);
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  scheduleManager?.stop();
  for (const [, worker] of activeWorkers) {
    worker.bridge.abortAll();
    try { await worker.tunnelManager.closeAll(); } catch {}
    try { await worker.bot.stop(); } catch {}
  }
  activeWorkers.clear();
  flushLicenseSync();
  fs.rmSync(PID_FILE, { force: true });
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
if (process.platform === "win32") process.on("SIGBREAK", shutdown);

main().catch(async (err) => {
  console.error("Fatal error:", err);
  await shutdown();
});
