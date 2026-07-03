/**
 * Belt observability — writes per-stage structured artifacts for observer,
 * reflector, and dropper runs.  Each artifact is a standalone JSON file in
 * .pi/blackhole/runs/{sessionId}/, making the memory pipeline's internal
 * state inspectable by both humans and future debugging agents.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Observation, Reflection } from "./ledger/types.js";

export interface TranscriptTurn {
  /** Role of the message sender. */
  role: "user" | "assistant" | "toolResult";
  /** Flattened text content, including thinking blocks prefixed with [thinking: ...]. */
  text: string;
  /** Tool call blocks if this is an assistant message with tool calls. */
  toolCalls?: Array<{ name: string; args: unknown }>;
  /** Tool name if this is a toolResult message. */
  toolName?: string;
}

export interface StageArtifact {
  /** Consolidation stage name. */
  stage: "observer" | "reflector" | "dropper";
  /** ISO-8601 timestamp of this run. */
  timestamp: string;
  /** Model used for this stage. */
  model: { provider: string; id: string };
  /** Summary of what was fed into the agentLoop. */
  input: Record<string, unknown>;
  /** Summary of what the agentLoop produced. */
  output: Record<string, unknown>;
  /** Wall-clock duration (ms). */
  durationMs?: number;
  /**
   * Full agent loop transcript — every message, thinking block, tool call,
   * and tool result exchanged during the run. Each entry is a flattened
   * representation of one AgentMessage from the loop.
   */
  transcript?: TranscriptTurn[];
}

/** Max characters per transcript entry's text field. Longer content gets truncated with a marker. */
const TRANSCRIPT_TEXT_MAX = 50_000;

/**
 * Flatten an AgentMessage-like object into a TranscriptTurn for artifact storage.
 * Extracts thinking blocks (prefixed), text content, tool calls, and tool results.
 */
export function messageToTranscriptTurn(msg: any): TranscriptTurn {
  if (!msg || typeof msg !== "object") {
    return { role: "assistant", text: "[invalid message]" };
  }
  const role = msg.role as string;
  if (role === "toolResult" || role === "tool_result") {
    const text = extractTextContent(msg.content);
    const toolName = msg.toolName ?? (msg as any).tool_name ?? "unknown";
    return { role: "toolResult", text: text.slice(0, TRANSCRIPT_TEXT_MAX), toolName };
  }
  if (role === "user") {
    return { role: "user", text: extractTextContent(msg.content).slice(0, TRANSCRIPT_TEXT_MAX) };
  }
  // assistant — extract thinking blocks, text, and tool calls
  const parts: string[] = [];
  const toolCalls: Array<{ name: string; args: unknown }> = [];
  const content = Array.isArray(msg.content) ? msg.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "thinking") {
      const thinking = typeof block.thinking === "string" ? block.thinking
        : typeof block.signature === "string" ? "[redacted thinking]"
        : "[unknown thinking]";
      parts.push(`[thinking: ${thinking}]`);
    } else if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "toolCall" || block.type === "tool_use") {
      const name = block.name ?? block.toolName ?? "unknown";
      toolCalls.push({ name, args: block.args ?? block.arguments ?? {} });
      parts.push(`[${name}(${JSON.stringify(block.args ?? block.arguments ?? {})})]`);
    }
  }
  return {
    role: "assistant",
    text: parts.join("\n").slice(0, TRANSCRIPT_TEXT_MAX),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n");
}

function sanitizeSessionId(id: string): string {
  // Replace characters unsafe for filesystem paths
  return id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
}

/**
 * Write a structured run artifact to the project's .pi/blackhole/runs/ directory.
 * No-op if cwd is unavailable or filesystem write fails.
 */
export function writeRunArtifact(
  cwd: string | undefined,
  sessionId: string,
  artifact: StageArtifact,
): void {
  if (!cwd) return;
  try {
    const dir = join(cwd, ".pi", "blackhole", "runs", sanitizeSessionId(sessionId));
    mkdirSync(dir, { recursive: true });
    const ts = artifact.timestamp.replace(/[:.]/g, "-");
    const file = join(dir, `${ts}-${artifact.stage}.json`);
    writeFileSync(file, JSON.stringify(artifact, null, 2) + "\n");
  } catch (e) {
    // Silently skip — observability is non-critical
    console.error("[pi-blackhole] run-artifact write failed:", String(e));
  }
}

/**
 * Emit an observer artifact summarizing the run.
 */
export function observerArtifact(
  model: { provider: string; id: string },
  chunkTokens: number,
  priorReflectionCount: number,
  priorObservationCount: number,
  sourceEntryCount: number,
  observations: Observation[],
  opts?: {
    emptyReason?: string;
    durationMs?: number;
    systemPrompt?: string;
    userPrompt?: string;
    coversUpToId?: string;
    transcript?: TranscriptTurn[];
  },
): StageArtifact {
  const { emptyReason, durationMs, systemPrompt, userPrompt, coversUpToId, transcript } = opts ?? {};
  return {
    stage: "observer",
    timestamp: new Date().toISOString(),
    model,
    input: {
      chunkTokens,
      priorReflections: priorReflectionCount,
      priorObservations: priorObservationCount,
      sourceEntryCount,
      ...(coversUpToId ? { coversUpToId } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(userPrompt ? { userPrompt } : {}),
    },
    output: emptyReason
      ? { emptyReason, observationCount: 0 }
      : {
          observationCount: observations.length,
          totalTokenCount: observations.reduce((s, o) => s + o.tokenCount, 0),
          observations: observations.map((o) => ({
            id: o.id,
            timestamp: o.timestamp,
            relevance: o.relevance,
            content: o.content,
            sourceEntryIds: o.sourceEntryIds,
            ...(o.kind ? { kind: o.kind } : {}),
          })),
        },
    durationMs,
    ...(transcript ? { transcript } : {}),
  };
}

/**
 * Emit a reflector artifact summarizing the run.
 */
export function reflectorArtifact(
  model: { provider: string; id: string },
  reflectionTokens: number,
  newObservationCount: number,
  newReflectionCount: number,
  reflections: Reflection[],
  opts?: {
    durationMs?: number;
    systemPrompt?: string;
    userPrompt?: string;
    transcript?: TranscriptTurn[];
  },
): StageArtifact {
  const { durationMs, systemPrompt, userPrompt, transcript } = opts ?? {};
  return {
    stage: "reflector",
    timestamp: new Date().toISOString(),
    model,
    input: {
      accumulatedTokens: reflectionTokens,
      newObservations: newObservationCount,
      newReflections: newReflectionCount,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(userPrompt ? { userPrompt } : {}),
    },
    output: {
      reflectionCount: reflections.length,
      totalTokenCount: reflections.reduce((s, r) => s + r.tokenCount, 0),
      reflections: reflections.map((r) => ({
        id: r.id,
        content: r.content,
        supportingObservationIds: r.supportingObservationIds,
      })),
    },
    durationMs,
    ...(transcript ? { transcript } : {}),
  };
}

/**
 * Emit a dropper artifact summarizing the run.
 */
export function dropperArtifact(
  model: { provider: string; id: string },
  dropTokens: number,
  activeObservationCount: number,
  reflectionCount: number,
  observationTokens: number,
  budgetTokens: number,
  droppedIds: string[] | undefined,
  fullness: number,
  urgency: string,
  opts?: {
    durationMs?: number;
    systemPrompt?: string;
    userPrompt?: string;
    transcript?: TranscriptTurn[];
  },
): StageArtifact {
  const { durationMs, systemPrompt, userPrompt, transcript } = opts ?? {};
  return {
    stage: "dropper",
    timestamp: new Date().toISOString(),
    model,
    input: {
      accumulatedTokens: dropTokens,
      activeObservations: activeObservationCount,
      reflections: reflectionCount,
      poolTokens: observationTokens,
      budgetTokens,
      fullness: Math.round(fullness * 100) / 100,
      urgency,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(userPrompt ? { userPrompt } : {}),
    },
    output: {
      droppedCount: droppedIds?.length ?? 0,
      droppedIds: droppedIds ?? [],
      keptCount: activeObservationCount - (droppedIds?.length ?? 0),
    },
    durationMs,
    ...(transcript ? { transcript } : {}),
  };
}
