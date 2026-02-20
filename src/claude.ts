import { query } from "@anthropic-ai/claude-code";
import { config } from "./config.js";
import { logTool, logApproval, logStatus } from "./log.js";

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
  ) => Promise<boolean>;
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
  { id: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
] as const;

const DEFAULT_MODEL = AVAILABLE_MODELS[0].id;

// chatId → Claude sessionId
const sessions = new Map<number, string>();
// chatId → total tokens accumulated
const sessionTokens = new Map<number, TokenUsage>();
// chatId → AbortController for active query
const activeAborts = new Map<number, AbortController>();
// chatId → selected model
const selectedModels = new Map<number, string>();

export function isProcessing(chatId: number): boolean {
  return activeAborts.has(chatId);
}

export function getSessionTokens(chatId: number): TokenUsage {
  return sessionTokens.get(chatId) || { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

export function clearSession(chatId: number): void {
  sessions.delete(chatId);
  sessionTokens.delete(chatId);
}

export function setModel(chatId: number, modelId: string): void {
  selectedModels.set(chatId, modelId);
  sessions.delete(chatId);
}

export function getModel(chatId: number): string {
  return selectedModels.get(chatId) || DEFAULT_MODEL;
}

export function cancelQuery(chatId: number): boolean {
  const controller = activeAborts.get(chatId);
  if (controller) {
    controller.abort();
    activeAborts.delete(chatId);
    return true;
  }
  return false;
}

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

function formatToolStatus(toolName: string): string {
  const toolLabels: Record<string, string> = {
    Read: "Reading file...",
    Bash: "Running command...",
    Edit: "Editing file...",
    MultiEdit: "Editing file...",
    Write: "Writing file...",
    Glob: "Searching files...",
    Grep: "Searching code...",
    WebSearch: "Searching the web...",
    WebFetch: "Fetching URL...",
    Task: "Running agent...",
    TodoWrite: "Updating tasks...",
    NotebookEdit: "Editing notebook...",
  };
  return toolLabels[toolName] || `Using ${toolName}...`;
}

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

export async function sendMessage(
  chatId: number,
  prompt: string,
  callbacks: SendCallbacks
): Promise<void> {
  const abortController = new AbortController();
  activeAborts.set(chatId, abortController);

  const sessionId = sessions.get(chatId);
  let hasStreamedText = false;

  // Cycle through thinking words until text starts streaming
  let wordIdx = Math.floor(Math.random() * THINKING_WORDS.length);
  const thinkingInterval = setInterval(() => {
    if (hasStreamedText || abortController.signal.aborted) {
      clearInterval(thinkingInterval);
      return;
    }
    wordIdx = (wordIdx + 1) % THINKING_WORDS.length;
    const word = THINKING_WORDS[wordIdx];
    callbacks.onStatusUpdate(word);
    logStatus(word);
  }, 2000);

  try {
    const model = selectedModels.get(chatId) || DEFAULT_MODEL;

    const q = query({
      prompt,
      options: {
        cwd: config.CLAUDE_WORKING_DIR,
        model,
        includePartialMessages: true,
        permissionMode: "default",
        ...(sessionId ? { resume: sessionId } : {}),
        abortController,
        canUseTool: async (toolName, input, { signal }) => {
          if (AUTO_APPROVE_TOOLS.includes(toolName)) {
            logTool(toolName, toolDetail(toolName, input as Record<string, unknown>));
            return { behavior: "allow" as const, updatedInput: input };
          }

          logTool(`${toolName} (awaiting approval)`, toolDetail(toolName, input as Record<string, unknown>));

          const approved = await Promise.race([
            callbacks.onToolApproval(
              toolName,
              input as Record<string, unknown>
            ),
            new Promise<boolean>((resolve) => {
              if (signal.aborted) {
                resolve(false);
                return;
              }
              signal.addEventListener("abort", () => resolve(false), {
                once: true,
              });
            }),
          ]);

          logApproval(toolName, approved);

          if (approved) {
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
        sessions.set(chatId, message.session_id);
      } else if (message.type === "stream_event") {
        const event = message.event as Record<string, unknown>;
        if (event.type === "content_block_start") {
          const block = event.content_block as Record<string, unknown> | undefined;
          if (block?.type === "tool_use" && typeof block.name === "string") {
            const status = formatToolStatus(block.name);
            callbacks.onStatusUpdate(status);
            logStatus(status);
          } else if (block?.type === "thinking") {
            callbacks.onStatusUpdate("Thinking deeply...");
            logStatus("Thinking deeply...");
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

          const prev = sessionTokens.get(chatId) || { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
          sessionTokens.set(chatId, {
            inputTokens: prev.inputTokens + usage.inputTokens,
            outputTokens: prev.outputTokens + usage.outputTokens,
            cacheCreationTokens: prev.cacheCreationTokens + usage.cacheCreationTokens,
            cacheReadTokens: prev.cacheReadTokens + usage.cacheReadTokens,
          });

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
    activeAborts.delete(chatId);
  }
}
