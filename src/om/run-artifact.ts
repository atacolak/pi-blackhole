/**
 * Belt observability — writes per-stage structured artifacts for observer,
 * reflector, and dropper runs.  Each artifact is a standalone JSON file in
 * .pi/blackhole/runs/{sessionId}/, making the memory pipeline's internal
 * state inspectable by both humans and future debugging agents.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Observation, Reflection } from "./ledger/types.js";

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
  },
): StageArtifact {
  const { emptyReason, durationMs, systemPrompt, userPrompt, coversUpToId } = opts ?? {};
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
  },
): StageArtifact {
  const { durationMs, systemPrompt, userPrompt } = opts ?? {};
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
  },
): StageArtifact {
  const { durationMs, systemPrompt, userPrompt } = opts ?? {};
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
  };
}
