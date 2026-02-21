import { Bot } from "grammy";
import { ClaudeBridge } from "./claude.js";
import { createManager } from "./manager.js";
import { createWorker } from "./worker.js";
import { loadBots, addBot, removeBot } from "./store.js";
import type { BotConfig } from "./store.js";

const activeWorkers = new Map<number, { config: BotConfig; bot: Bot; bridge: ClaudeBridge }>();

const WORKER_COMMANDS = [
  { command: "new",     description: "Start a fresh session" },
  { command: "model",   description: "Switch Claude model (Opus / Sonnet / Haiku)" },
  { command: "cost",    description: "Show token usage for this session" },
  { command: "session", description: "Get session ID to resume in CLI" },
  { command: "cancel",  description: "Abort the current operation" },
  { command: "help",    description: "Show help" },
];

const MANAGER_COMMANDS = [
  { command: "bots",   description: "List active worker bots" },
  { command: "add",    description: "Add a new worker bot" },
  { command: "remove", description: "Remove a worker bot" },
  { command: "cancel", description: "Cancel current operation" },
  { command: "help",   description: "Show help" },
];

async function startWorker(botConfig: BotConfig): Promise<void> {
  const bridge = new ClaudeBridge(botConfig.id, botConfig.workingDir, botConfig.username);
  const bot = createWorker(botConfig, bridge);

  await bot.init();
  await bot.api.setMyCommands(WORKER_COMMANDS);

  addBot(botConfig);
  activeWorkers.set(botConfig.id, { config: botConfig, bot, bridge });

  // Fire-and-forget: polling runs in background
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
  const managerBot = createManager({ startWorker, stopWorker, getActiveWorkers });
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
  for (const [, worker] of activeWorkers) {
    worker.bridge.abortAll();
    try { await worker.bot.stop(); } catch {}
  }
  activeWorkers.clear();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
