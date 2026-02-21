import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import "dotenv/config";

export const DATA_DIR = path.join(os.homedir(), ".claude-on-phone");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

interface SavedConfig {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_OWNER_ID?: number;
}

function loadSavedConfig(): SavedConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function required(name: string, savedValue?: string | number): string {
  const value = process.env[name] ?? (savedValue !== undefined ? String(savedValue) : undefined);
  if (!value) {
    console.error(`Missing required config: ${name}`);
    console.error("Run: claude-on-phone setup");
    process.exit(1);
  }
  return value;
}

const saved = loadSavedConfig();

export const config = {
  TELEGRAM_BOT_TOKEN: required("TELEGRAM_BOT_TOKEN", saved.TELEGRAM_BOT_TOKEN),
  TELEGRAM_OWNER_ID: Number(required("TELEGRAM_OWNER_ID", saved.TELEGRAM_OWNER_ID)),
  DATA_DIR,
};
