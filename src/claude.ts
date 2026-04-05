import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { logTool, logApproval, logStatus } from "./log.js";
import { checkLicenseForQuery } from "./license.js";

const COOLDOWN_MS = 2000;
const THINKING_ROTATE_MS = 2000;

const AUTO_APPROVE_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Task",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskOutput",
  "TaskStop",
];

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface AskUserQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

export interface SendCallbacks {
  onStreamChunk: (text: string) => void;
  onStatusUpdate: (status: string) => void;
  onToolApproval: (
    toolName: string,
    input: Record<string, unknown>
  ) => Promise<"allow" | "always" | "deny">;
  onAskUser: (questions: AskUserQuestion[]) => Promise<Record<string, string>>;
  onPlanApproval: (planFileContent?: string) => Promise<boolean>;
  onResult: (result: {
    text: string;
    usage: TokenUsage;
    turns: number;
    durationMs: number;
  }) => void;
  onError: (error: Error) => void;
  onSessionReset?: () => void;
}

export const AVAILABLE_MODELS = [
  { id: "claude-opus-4-6", label: "Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
] as const;

const DEFAULT_MODEL = AVAILABLE_MODELS[0].id;

// Claude Code-style spinner words shown during thinking
const THINKING_WORDS = [
  "Thinking...",
  "Reasoning...",
  "Analyzing...",
  "Contemplating...",
  "Processing...",
  "Investigating...",
  "Considering...",
  "Evaluating...",
  "Synthesizing...",
  "Formulating...",
  "Pondering...",
  "Deliberating...",
  "Examining...",
  "Deciphering...",
];

function formatToolStatus(toolName: string, detail?: string): string {
  const toolVerbs: Record<string, string> = {
    Read: "Reading",
    Bash: "Running",
    Edit: "Editing",
    MultiEdit: "Editing",
    Write: "Writing",
    Glob: "Searching files",
    Grep: "Searching code",
    WebSearch: "Searching",
    WebFetch: "Fetching",
    Task: "Running agent",
    TodoWrite: "Updating tasks",
    NotebookEdit: "Editing notebook",
    EnterPlanMode: "Planning",
    ExitPlanMode: "Finalizing plan",
  };
  const verb = toolVerbs[toolName] || `Using ${toolName}`;
  return detail ? `${verb}: ${detail}` : `${verb}...`;
}

// Full path/detail for terminal logs
function toolDetail(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      return String(input.file_path || "");
    case "Bash":
      return String(input.command || "").slice(0, 80);
    case "Glob":
      return String(input.pattern || "");
    case "Grep":
      return String(input.pattern || "");
    default:
      return "";
  }
}

// Short detail for Telegram status (filename only, truncated commands)
function toolStatusDetail(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return path.basename(String(input.file_path || ""));
    case "NotebookEdit":
      return path.basename(String(input.notebook_path || ""));
    case "Bash":
      return String(input.command || "").slice(0, 60);
    case "Glob":
      return String(input.pattern || "");
    case "Grep":
      return `"${String(input.pattern || "").slice(0, 40)}"`;
    case "WebSearch":
      return `"${String(input.query || "").slice(0, 40)}"`;
    case "WebFetch":
      return String(input.url || "").slice(0, 50);
    default:
      return "";
  }
}

interface PersistedState {
  sessions: Record<string, string>;
  sessionTokens: Record<string, TokenUsage>;
  selectedModels: Record<string, string>;
}

export class ClaudeBridge {
  readonly workingDir: string;
  readonly botId: number;
  private readonly tag: string;
  private readonly stateFile: string;

  private sessions = new Map<number, string>();
  private sessionTokens = new Map<number, TokenUsage>();
  private activeAborts = new Map<number, AbortController>();
  private selectedModels = new Map<number, string>();
  private lastQueryEnd = new Map<number, number>();
  private lastPrompts = new Map<number, string>();
  private sessionApprovedTools = new Map<number, Set<string>>();
  private yoloChats = new Set<number>();
  // Strip CLAUDECODE env var once so SDK subprocesses don't refuse to start
  // when the daemon is launched from within a Claude Code session.
  private readonly cleanEnv: Record<string, string | undefined>;

  constructor(botId: number, workingDir: string, tag: string) {
    this.botId = botId;
    this.workingDir = workingDir;
    this.tag = tag;
    this.stateFile = path.join(config.DATA_DIR, `state-${botId}.json`);
    // Strip CLAUDECODE so SDK subprocesses don't refuse to start,
    // and strip ANTHROPIC_API_KEY so stale keys from .env files or
    // shell env don't override the user's working Claude Code CLI auth.
    // If explicitly configured in our config, re-add it.
    const { CLAUDECODE: _, ANTHROPIC_API_KEY: __, ...cleanEnv } = process.env;
    if (config.ANTHROPIC_API_KEY) {
      cleanEnv.ANTHROPIC_API_KEY = config.ANTHROPIC_API_KEY;
    }
    // Forward env vars from Claude Code's settings.json (e.g. ANTHROPIC_BASE_URL
    // for users behind proxies). Only set if not already in process.env.
    try {
      const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        if (settings.env && typeof settings.env === "object") {
          for (const [key, value] of Object.entries(settings.env)) {
            if (typeof value === "string" && !cleanEnv[key]) {
              cleanEnv[key] = value;
            }
          }
        }
      }
    } catch {}
    this.cleanEnv = cleanEnv;
    this.loadState();
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const raw: PersistedState = JSON.parse(fs.readFileSync(this.stateFile, "utf-8"));
      for (const [k, v] of Object.entries(raw.sessions || {})) this.sessions.set(Number(k), v);
      for (const [k, v] of Object.entries(raw.sessionTokens || {})) this.sessionTokens.set(Number(k), v);
      for (const [k, v] of Object.entries(raw.selectedModels || {})) this.selectedModels.set(Number(k), v);
    } catch {}
  }

  private saveState(): void {
    try {
      fs.mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
      const state: PersistedState = {
        sessions: Object.fromEntries(this.sessions),
        sessionTokens: Object.fromEntries(this.sessionTokens),
        selectedModels: Object.fromEntries(this.selectedModels),
      };
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    } catch {}
  }

  isProcessing(chatId: number): boolean {
    return this.activeAborts.has(chatId);
  }

  getSessionTokens(chatId: number): TokenUsage {
    return this.sessionTokens.get(chatId) || { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  }

  clearSession(chatId: number): void {
    this.sessions.delete(chatId);
    this.sessionTokens.delete(chatId);
    this.sessionApprovedTools.delete(chatId);
    this.yoloChats.delete(chatId);
    this.saveState();
  }

  setYolo(chatId: number, enabled: boolean): void {
    if (enabled) {
      this.yoloChats.add(chatId);
    } else {
      this.yoloChats.delete(chatId);
    }
  }

  isYolo(chatId: number): boolean {
    return this.yoloChats.has(chatId);
  }

  setModel(chatId: number, modelId: string): void {
    this.selectedModels.set(chatId, modelId);
    this.sessions.delete(chatId);
    this.saveState();
  }

  getModel(chatId: number): string {
    return this.selectedModels.get(chatId) || DEFAULT_MODEL;
  }

  getSessionId(chatId: number): string | undefined {
    return this.sessions.get(chatId);
  }

  setSessionId(chatId: number, sessionId: string): void {
    this.sessions.set(chatId, sessionId);
    this.sessionTokens.delete(chatId);
    this.sessionApprovedTools.delete(chatId);
    this.saveState();
  }

  getProjectSessionsDir(): string {
    const projectKey = this.workingDir.replace(/[\\/]/g, "-");
    return path.join(os.homedir(), ".claude", "projects", projectKey);
  }

  listRecentSessions(limit = 10): Array<{ sessionId: string; modifiedAt: Date; promptPreview: string }> {
    const dir = this.getProjectSessionsDir();
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const fullPath = path.join(dir, f);
        const stat = fs.statSync(fullPath);
        return { name: f, fullPath, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);

    return files.map(({ name, fullPath, mtime }) => {
      const sessionId = name.replace(/\.jsonl$/, "");
      let promptPreview = "(no preview)";

      try {
        const fd = fs.openSync(fullPath, "r");
        const buf = Buffer.alloc(8192);
        const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
        fs.closeSync(fd);

        const chunk = buf.toString("utf-8", 0, bytesRead);
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type === "user" && entry.sessionId === sessionId) {
              const content = entry.message?.content;
              let text = "";
              if (typeof content === "string") {
                text = content;
              } else if (Array.isArray(content)) {
                const textBlock = content.find((b: Record<string, unknown>) => b.type === "text");
                if (textBlock) text = String(textBlock.text || "");
              }
              if (text) {
                promptPreview = text.length > 80 ? text.slice(0, 80) + "..." : text;
                break;
              }
            }
          } catch {}
        }
      } catch {}

      return { sessionId, modifiedAt: new Date(mtime), promptPreview };
    });
  }

  getSessionHistory(sessionId: string, limit = 10): Array<{ role: "user" | "assistant"; text: string; timestamp: string }> {
    try {
      const filePath = path.join(this.getProjectSessionsDir(), `${sessionId}.jsonl`);
      if (!fs.existsSync(filePath)) return [];

      const raw = fs.readFileSync(filePath, "utf-8");
      const entries: Array<{ role: "user" | "assistant"; text: string; timestamp: string }> = [];

      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type !== "user" && entry.type !== "assistant") continue;

          const content = entry.message?.content;
          let text = "";

          if (entry.type === "user") {
            if (typeof content === "string") {
              text = content;
            } else if (Array.isArray(content)) {
              const textBlock = content.find((b: Record<string, unknown>) => b.type === "text");
              if (textBlock) text = String(textBlock.text || "");
            }
          } else {
            // assistant — extract only text blocks, skip thinking/tool_use
            if (Array.isArray(content)) {
              const texts = content
                .filter((b: Record<string, unknown>) => b.type === "text")
                .map((b: Record<string, unknown>) => String(b.text || ""));
              text = texts.join("\n");
            }
          }

          if (!text.trim()) continue;

          const truncated = text.length > 500 ? text.slice(0, 500) + "..." : text;
          entries.push({
            role: entry.type as "user" | "assistant",
            text: truncated,
            timestamp: entry.timestamp || "",
          });
        } catch {}
      }

      return entries.slice(-limit);
    } catch {
      return [];
    }
  }

  cancelQuery(chatId: number): boolean {
    const controller = this.activeAborts.get(chatId);
    if (controller) {
      controller.abort();
      this.activeAborts.delete(chatId);
      return true;
    }
    return false;
  }

  isCoolingDown(chatId: number): boolean {
    const last = this.lastQueryEnd.get(chatId);
    if (!last) return false;
    return Date.now() - last < COOLDOWN_MS;
  }

  setLastPrompt(chatId: number, prompt: string): void {
    this.lastPrompts.set(chatId, prompt);
  }

  getLastPrompt(chatId: number): string | undefined {
    return this.lastPrompts.get(chatId);
  }

  abortAll(): void {
    for (const [, controller] of this.activeAborts) {
      controller.abort();
    }
    this.activeAborts.clear();
  }

  getTempDir(): string {
    return path.join(os.tmpdir(), `clautel-${this.botId}`);
  }

  cleanupTempFiles(): void {
    try {
      const tmpDir = this.getTempDir();
      if (fs.existsSync(tmpDir)) {
        const files = fs.readdirSync(tmpDir);
        for (const f of files) {
          fs.unlinkSync(path.join(tmpDir, f));
        }
        fs.rmdirSync(tmpDir);
      }
    } catch {}
  }

  async sendMessage(
    chatId: number,
    prompt: string,
    callbacks: SendCallbacks,
    permissionMode: "default" | "bypassPermissions" = "default",
    maxTurns?: number
  ): Promise<void> {
    // Secondary anti-bypass license check
    if (!checkLicenseForQuery().allowed) throw new Error("License required");

    const abortController = new AbortController();
    this.activeAborts.set(chatId, abortController);

    const sessionId = this.sessions.get(chatId);
    let hasStreamedText = false;

    let wordIdx = Math.floor(Math.random() * THINKING_WORDS.length);
    const thinkingInterval = setInterval(() => {
      if (hasStreamedText || abortController.signal.aborted) {
        clearInterval(thinkingInterval);
        return;
      }
      wordIdx = (wordIdx + 1) % THINKING_WORDS.length;
      const word = THINKING_WORDS[wordIdx];
      callbacks.onStatusUpdate(word);
      logStatus(word, this.tag);
    }, THINKING_ROTATE_MS);

    try {
      const model = this.selectedModels.get(chatId) || DEFAULT_MODEL;

      let lastWrittenFilePath: string | null = null;

      const q = query({
        prompt,
        options: {
          env: this.cleanEnv,
          cwd: this.workingDir,
          model,
          includePartialMessages: true,
          permissionMode,
          settingSources: ['user', 'project', 'local'],
          ...(maxTurns ? { maxTurns } : {}),
          ...(sessionId ? { resume: sessionId } : {}),
          abortController,
          canUseTool: async (toolName, input, { signal }) => {
            // Stop thinking words — tool status is more informative
            clearInterval(thinkingInterval);

            const inp = input as Record<string, unknown>;
            const detail = toolDetail(toolName, inp);
            const statusDetail = toolStatusDetail(toolName, inp) || undefined;

            // Interactive: relay questions to user and collect answers
            if (toolName === "AskUserQuestion") {
              logTool(toolName, "", this.tag);
              callbacks.onStatusUpdate("Asking user...");
              try {
                const questions = (inp.questions || []) as AskUserQuestion[];
                const answers = await Promise.race([
                  callbacks.onAskUser(questions),
                  new Promise<Record<string, string>>((_, reject) => {
                    if (signal.aborted) { reject(new Error("aborted")); return; }
                    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
                  }),
                ]);
                return { behavior: "allow" as const, updatedInput: { ...inp, answers } };
              } catch {
                return { behavior: "deny" as const, message: "User did not answer (cancelled or timed out)" };
              }
            }

            // Track the last file written (used to capture plan content)
            if (toolName === "Write") {
              const filePath = inp.file_path;
              if (typeof filePath === "string") {
                lastWrittenFilePath = filePath;
              }
            }

            // Interactive: show plan and get approval before proceeding
            if (toolName === "ExitPlanMode") {
              logTool(toolName, "", this.tag);
              callbacks.onStatusUpdate("Waiting for plan approval...");
              let planFileContent: string | undefined;

              // Method 1: Read from tracked Write tool path (stream events or canUseTool)
              if (lastWrittenFilePath) {
                try {
                  planFileContent = fs.readFileSync(lastWrittenFilePath, "utf-8");
                } catch {}
              }

              // Method 2: Find most recent plan file in ~/.claude/plans/
              if (!planFileContent) {
                try {
                  const plansDir = path.join(os.homedir(), ".claude", "plans");
                  if (fs.existsSync(plansDir)) {
                    const now = Date.now();
                    const files = fs.readdirSync(plansDir)
                      .filter(f => f.endsWith(".md"))
                      .map(f => ({ name: f, mtime: fs.statSync(path.join(plansDir, f)).mtimeMs }))
                      .filter(f => now - f.mtime < 5 * 60 * 1000) // written in last 5 min
                      .sort((a, b) => b.mtime - a.mtime);
                    if (files.length > 0) {
                      planFileContent = fs.readFileSync(path.join(plansDir, files[0].name), "utf-8");
                    }
                  }
                } catch {}
              }
              const approved = await Promise.race([
                callbacks.onPlanApproval(planFileContent),
                new Promise<boolean>((resolve) => {
                  if (signal.aborted) { resolve(false); return; }
                  signal.addEventListener("abort", () => resolve(false), { once: true });
                }),
              ]);
              if (approved) {
                return { behavior: "allow" as const, updatedInput: input };
              }
              return { behavior: "deny" as const, message: "User rejected the plan via Telegram" };
            }

            if (AUTO_APPROVE_TOOLS.includes(toolName)) {
              logTool(toolName, detail, this.tag);
              callbacks.onStatusUpdate(formatToolStatus(toolName, statusDetail));
              return { behavior: "allow" as const, updatedInput: input };
            }

            // Check if user already approved this tool for the session
            if (this.sessionApprovedTools.get(chatId)?.has(toolName)) {
              logTool(`${toolName} (session-approved)`, detail, this.tag);
              callbacks.onStatusUpdate(formatToolStatus(toolName, statusDetail));
              return { behavior: "allow" as const, updatedInput: input };
            }

            logTool(`${toolName} (awaiting approval)`, detail, this.tag);
            callbacks.onStatusUpdate("Waiting for approval...");

            const result = await Promise.race([
              callbacks.onToolApproval(toolName, inp),
              new Promise<"deny">((resolve) => {
                if (signal.aborted) {
                  resolve("deny");
                  return;
                }
                signal.addEventListener("abort", () => resolve("deny"), {
                  once: true,
                });
              }),
            ]);

            if (result === "always") {
              if (!this.sessionApprovedTools.has(chatId)) {
                this.sessionApprovedTools.set(chatId, new Set());
              }
              this.sessionApprovedTools.get(chatId)!.add(toolName);
            }

            logApproval(toolName, result, this.tag);

            if (result === "allow" || result === "always") {
              return { behavior: "allow" as const, updatedInput: input };
            }
            return {
              behavior: "deny" as const,
              message: "User denied this action via Telegram",
            };
          },
        },
      });

      // Track tool_use blocks from stream events to capture Write file paths
      // (canUseTool may not be called for Write in the agent SDK)
      let streamToolName = "";
      let streamToolInputJson = "";

      for await (const message of q) {
        if (abortController.signal.aborted) break;

        if (message.type === "system" && message.subtype === "init") {
          if (sessionId && message.session_id !== sessionId) {
            callbacks.onSessionReset?.();
          }
          this.sessions.set(chatId, message.session_id);
        } else if (message.type === "stream_event") {
          const event = message.event as Record<string, unknown>;
          if (event.type === "content_block_start") {
            const block = event.content_block as Record<string, unknown> | undefined;
            if (block?.type === "tool_use" && typeof block.name === "string") {
              streamToolName = block.name;
              streamToolInputJson = "";
              const status = formatToolStatus(block.name);
              callbacks.onStatusUpdate(status);
              logStatus(status, this.tag);
            } else if (block?.type === "thinking") {
              callbacks.onStatusUpdate("Thinking deeply...");
              logStatus("Thinking deeply...", this.tag);
            }
          } else if (event.type === "content_block_delta") {
            const delta = event.delta as Record<string, unknown> | undefined;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              if (!hasStreamedText) {
                hasStreamedText = true;
                clearInterval(thinkingInterval);
              }
              callbacks.onStreamChunk(delta.text);
            } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
              streamToolInputJson += delta.partial_json;
            }
          } else if (event.type === "content_block_stop") {
            if (streamToolName === "Write" && streamToolInputJson) {
              try {
                const parsed = JSON.parse(streamToolInputJson);
                if (typeof parsed.file_path === "string") {
                  lastWrittenFilePath = parsed.file_path;
                }
              } catch {}
            }
            streamToolName = "";
            streamToolInputJson = "";
          }
        } else if (message.type === "result") {
          clearInterval(thinkingInterval);
          if (message.subtype === "success") {
            const msg = message as Record<string, unknown>;
            const rawUsage = msg.usage as Record<string, number> | undefined;
            const usage: TokenUsage = {
              inputTokens: rawUsage?.input_tokens || 0,
              outputTokens: rawUsage?.output_tokens || 0,
              cacheCreationTokens: rawUsage?.cache_creation_input_tokens || 0,
              cacheReadTokens: rawUsage?.cache_read_input_tokens || 0,
            };

            const prev = this.sessionTokens.get(chatId) || { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
            this.sessionTokens.set(chatId, {
              inputTokens: prev.inputTokens + usage.inputTokens,
              outputTokens: prev.outputTokens + usage.outputTokens,
              cacheCreationTokens: prev.cacheCreationTokens + usage.cacheCreationTokens,
              cacheReadTokens: prev.cacheReadTokens + usage.cacheReadTokens,
            });
            this.saveState();

            let resultText = msg.result as string || "";

            // Detect Claude API auth failures and provide actionable guidance
            if (resultText.includes("API Error: 403") || resultText.includes("Failed to authenticate")) {
              resultText = "Claude Code authentication failed.\n\nTo fix, run these commands on your server:\n1. claude login\n2. clautel stop && clautel start\n\nIf that doesn't work, update Claude Code:\n  npm install -g @anthropic-ai/claude-code@latest";
            }

            callbacks.onResult({
              text: resultText,
              usage,
              turns: msg.num_turns as number || 0,
              durationMs: msg.duration_ms as number || 0,
            });
          } else {
            const errors = (message as Record<string, unknown>).errors as string[] | undefined;
            callbacks.onError(
              new Error(errors?.join(", ") || "Claude query failed")
            );
          }
          break; // Result is the final message — exit immediately so the bot is ready for new requests
        }
      }
    } catch (error) {
      clearInterval(thinkingInterval);
      if (!abortController.signal.aborted) {
        callbacks.onError(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    } finally {
      clearInterval(thinkingInterval);
      this.activeAborts.delete(chatId);
      this.lastQueryEnd.set(chatId, Date.now());
      this.cleanupTempFiles();
    }
  }
}
