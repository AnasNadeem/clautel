import fs from "node:fs";
import path from "node:path";
import cron from "node-cron";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR } from "./config.js";

const SCHEDULES_FILE = path.join(DATA_DIR, "schedules.json");

export interface Schedule {
  id: string;
  botId: number;
  chatId: number;
  prompt: string;
  cronExpr: string;
  humanLabel: string;
  createdAt: string;
  lastRunAt: string | null;
}

export type ScheduleRunCallback = (
  botId: number,
  chatId: number,
  prompt: string,
  scheduleId: string
) => Promise<void>;

// --- Persistence ---

export function loadSchedules(): Schedule[] {
  try {
    if (!fs.existsSync(SCHEDULES_FILE)) return [];
    return JSON.parse(fs.readFileSync(SCHEDULES_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveSchedules(schedules: Schedule[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2), { mode: 0o600 });
}

// --- Schedule Manager ---

export class ScheduleManager {
  private tasks = new Map<string, cron.ScheduledTask>();
  private runCallback: ScheduleRunCallback;

  constructor(runCallback: ScheduleRunCallback) {
    this.runCallback = runCallback;
  }

  start(schedules: Schedule[]): void {
    for (const schedule of schedules) {
      this.startTask(schedule);
    }
    if (schedules.length > 0) {
      console.log(`Loaded ${schedules.length} scheduled task(s)`);
    }
  }

  private startTask(schedule: Schedule): void {
    if (!cron.validate(schedule.cronExpr)) {
      console.error(`[scheduler] Invalid cron expression for schedule ${schedule.id}: ${schedule.cronExpr}`);
      return;
    }

    const task = cron.schedule(schedule.cronExpr, async () => {
      console.log(`[scheduler] Running: ${schedule.humanLabel} (${schedule.id})`);

      // Update lastRunAt
      const schedules = loadSchedules();
      const idx = schedules.findIndex((s) => s.id === schedule.id);
      if (idx !== -1) {
        schedules[idx].lastRunAt = new Date().toISOString();
        saveSchedules(schedules);
      }

      await this.runCallback(schedule.botId, schedule.chatId, schedule.prompt, schedule.id);
    });

    this.tasks.set(schedule.id, task);
  }

  add(schedule: Schedule): void {
    const schedules = loadSchedules().filter((s) => s.id !== schedule.id);
    schedules.push(schedule);
    saveSchedules(schedules);
    this.startTask(schedule);
  }

  remove(scheduleId: string): boolean {
    const task = this.tasks.get(scheduleId);
    if (!task) return false;
    task.stop();
    this.tasks.delete(scheduleId);
    const schedules = loadSchedules().filter((s) => s.id !== scheduleId);
    saveSchedules(schedules);
    return true;
  }

  removeAllForBot(botId: number): void {
    const schedules = loadSchedules().filter((s) => s.botId === botId);
    for (const s of schedules) {
      this.remove(s.id);
    }
  }

  getForBot(botId: number): Schedule[] {
    return loadSchedules().filter((s) => s.botId === botId);
  }

  getAll(): Schedule[] {
    return loadSchedules();
  }

  stop(): void {
    for (const [, task] of this.tasks) {
      task.stop();
    }
    this.tasks.clear();
  }
}

// --- Claude-powered schedule parsing (via Claude Code SDK) ---

export async function parseScheduleWithClaude(input: string): Promise<{
  cronExpr: string;
  humanLabel: string;
  prompt: string;
} | null> {
  const prompt =
    `Parse this schedule request and return ONLY valid JSON with no explanation or markdown:\n` +
    `{"cronExpr": "...", "humanLabel": "...", "prompt": "..."}\n\n` +
    `Rules:\n` +
    `- cronExpr: standard 5-field cron expression\n` +
    `- humanLabel: short human-readable label like "daily 9am", "every monday 9am", "every 3 days"\n` +
    `- prompt: rewrite the task as a clear, precise, actionable instruction for an AI agent running autonomously with no human present\n\n` +
    `Input: "${input.replace(/"/g, '\\"')}"`;

  try {
    // Strip CLAUDECODE env var so SDK subprocess doesn't refuse to start
    const { CLAUDECODE: _, ...cleanEnv } = process.env;

    let resultText = "";
    const q = query({
      prompt,
      options: {
        env: cleanEnv,
        model: "claude-haiku-4-5-20251001",
        maxTurns: 1,
        permissionMode: "bypassPermissions",
      },
    });

    for await (const message of q) {
      if (message.type === "result" && message.subtype === "success") {
        resultText = (message as Record<string, unknown>).result as string || "";
      }
    }

    if (!resultText) {
      console.error("[scheduler] No result from Claude Code");
      return null;
    }

    // Extract JSON from response (may be wrapped in markdown code fences)
    const jsonMatch = resultText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[scheduler] No JSON found in response:", resultText);
      return null;
    }

    return JSON.parse(jsonMatch[0]) as { cronExpr: string; humanLabel: string; prompt: string };
  } catch (err) {
    console.error("[scheduler] Parse error:", err);
    return null;
  }
}

export function generateScheduleId(): string {
  return `sched_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
