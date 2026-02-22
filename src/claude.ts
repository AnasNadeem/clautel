import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-code";
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
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
];

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface SendCallbacks {
  onStreamChunk: (text: string) => void;
  onStatusUpdate: (status: string) => void;
  onToolApproval: (
    toolName: string,
    input: Record<string, unknown>
  ) => Promise<"allow" | "always" | "deny">;
  onResult: (result: {
    text: string;
    usage: TokenUsage;
    turns: number;
    durationMs: number;
  }) => void;
  onError: (error: Error) => void;
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

  constructor(botId: number, workingDir: string, tag: string) {
    this.botId = botId;
    this.workingDir = workingDir;
    this.tag = tag;
    this.stateFile = path.join(config.DATA_DIR, `state-${botId}.json`);
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
    this.saveState();
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
    return path.join(os.tmpdir(), `claude-on-phone-${this.botId}`);
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
    callbacks: SendCallbacks
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

      const q = query({
        prompt,
        options: {
          cwd: this.workingDir,
          model,
          includePartialMessages: true,
          permissionMode: "default",
          ...(sessionId ? { resume: sessionId } : {}),
          abortController,
          canUseTool: async (toolName, input, { signal }) => {
            // Stop thinking words — tool status is more informative
            clearInterval(thinkingInterval);

            const inp = input as Record<string, unknown>;
            const detail = toolDetail(toolName, inp);
            const statusDetail = toolStatusDetail(toolName, inp) || undefined;

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

      for await (const message of q) {
        if (abortController.signal.aborted) break;

        if (message.type === "system" && message.subtype === "init") {
          this.sessions.set(chatId, message.session_id);
        } else if (message.type === "stream_event") {
          const event = message.event as Record<string, unknown>;
          if (event.type === "content_block_start") {
            const block = event.content_block as Record<string, unknown> | undefined;
            if (block?.type === "tool_use" && typeof block.name === "string") {
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
            }
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

            callbacks.onResult({
              text: msg.result as string || "",
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
