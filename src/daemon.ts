import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Bot } from "grammy";
import { ClaudeBridge } from "./claude.js";
import { createManager } from "./manager.js";
import { createWorker } from "./worker.js";
import { loadBots, addBot, removeBot } from "./store.js";
import type { BotConfig } from "./store.js";
import { DATA_DIR } from "./config.js";

import { checkLicenseForStartup, startPeriodicValidation, flushLicenseSync, getPaymentUrl, detectClaudePlan, getPlanLabel, LICENSE_CANARY, checkLicenseForQuery } from "./license.js";

// Cross-module integrity: verify license module hasn't been patched
if (LICENSE_CANARY !== "L1c3ns3-Ch3ck-V2") {
  console.error("Integrity check failed: license module has been tampered with.");
  process.exit(1);
}

// Compute function hash at startup for periodic runtime verification
const LICENSE_FN_HASH = crypto.createHash("sha256").update(checkLicenseForQuery.toString()).digest("hex");

const PID_FILE = path.join(DATA_DIR, "daemon.pid");
const HEALTH_CHECK_INTERVAL_MS = 60_000; // 1 minute — fast recovery after sleep/network loss

const activeWorkers = new Map<number, { config: BotConfig; bot: Bot; bridge: ClaudeBridge }>();
let healthCheckTimer: NodeJS.Timeout | null = null;
let licenseTimer: NodeJS.Timeout | null = null;

const WORKER_COMMANDS = [
  { command: "new",      description: "Start a fresh session" },
  { command: "model",    description: "Switch Claude model (Opus / Sonnet / Haiku)" },
  { command: "cost",     description: "Show token usage for this session" },
  { command: "session",  description: "Get session ID to resume in CLI" },
  { command: "cancel",   description: "Abort the current operation" },
  { command: "feedback", description: "Send feedback or report an issue" },
  { command: "help",     description: "Show help" },
];

const MANAGER_COMMANDS = [
  { command: "bots",         description: "List active worker bots" },
  { command: "add",          description: "Add a new worker bot" },
  { command: "remove",       description: "Remove a worker bot" },
  { command: "subscribe",    description: "Get a license or upgrade" },
  { command: "subscription", description: "View license, billing & cancel" },
  { command: "feedback",     description: "Send feedback or report an issue" },
  { command: "cancel",       description: "Cancel current operation" },
  { command: "help",         description: "Show help" },
];

async function startWorker(botConfig: BotConfig): Promise<void> {
  const bridge = new ClaudeBridge(botConfig.id, botConfig.workingDir, botConfig.username);
  const bot = createWorker(botConfig, bridge);

  await bot.init();
  await bot.api.setMyCommands(WORKER_COMMANDS);

  addBot(botConfig);
  activeWorkers.set(botConfig.id, { config: botConfig, bot, bridge });

  // Fire-and-forget: polling runs in background
  // On error, remove from activeWorkers but KEEP in bots.json so health check restarts it
  bot.start().catch((err: Error) => {
    console.error(`[${botConfig.username}] Polling error:`, err.message);
    activeWorkers.delete(botConfig.id);
  });

  console.log(`Worker started: @${botConfig.username} → ${botConfig.workingDir}`);
}

async function stopWorker(botId: number): Promise<void> {
  const worker = activeWorkers.get(botId);
  if (!worker) return;

  worker.bridge.abortAll();
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
      process.exit(1);
    }
    console.error("[manager] Error:", err.message);
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

  // Periodic health check: restart dead workers and recover saved bots
  healthCheckTimer = setInterval(async () => {
    // 0. Runtime integrity check — verify license function hasn't been hot-patched
    const currentHash = crypto.createHash("sha256").update(checkLicenseForQuery.toString()).digest("hex");
    if (currentHash !== LICENSE_FN_HASH) {
      console.error("Integrity check failed: license function has been modified at runtime.");
      process.exit(1);
    }

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
        try {
          await startWorker(botConfig);
          console.log(`[${botConfig.username}] Recovered from saved config`);
        } catch (err) {
          console.error(`[${botConfig.username}] Recovery failed: ${(err as Error).message}`);
        }
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  // Start manager bot polling — keeps the process alive
  await managerBot.start({
    onStart: (info) => {
      console.log(`Manager bot: @${info.username}`);
      console.log(`Active workers: ${activeWorkers.size}`);
      console.log(`\nReady! DM @${info.username} to manage bots`);
    },
  });
}

const shutdown = async () => {
  console.log("\nShutting down...");
  if (licenseTimer) clearInterval(licenseTimer);
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  for (const [, worker] of activeWorkers) {
    worker.bridge.abortAll();
    try { await worker.bot.stop(); } catch {}
  }
  activeWorkers.clear();
  flushLicenseSync();
  fs.rmSync(PID_FILE, { force: true });
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
