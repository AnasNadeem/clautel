import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export interface BotConfig {
  id: number;
  token: string;
  username: string;
  workingDir: string;
}

const BOTS_FILE = path.join(config.DATA_DIR, "bots.json");

function ensureDataDir(): void {
  fs.mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
}

export function loadBots(): BotConfig[] {
  try {
    if (!fs.existsSync(BOTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(BOTS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

export function saveBots(bots: BotConfig[]): void {
  ensureDataDir();
  fs.writeFileSync(BOTS_FILE, JSON.stringify(bots, null, 2), { mode: 0o600 });
}

export function addBot(bot: BotConfig): void {
  const bots = loadBots().filter((b) => b.id !== bot.id);
  bots.push(bot);
  saveBots(bots);
}

export function removeBot(botId: number): void {
  const bots = loadBots().filter((b) => b.id !== botId);
  saveBots(bots);
}

export function getBots(): BotConfig[] {
  return loadBots();
}
