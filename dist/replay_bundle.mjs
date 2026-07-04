#!/usr/bin/env node

// src/replay.ts
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { getModel } from "@earendil-works/pi-ai";

// src/om/agents/dropper/agent.ts
import { agentLoop } from "@earendil-works/pi-agent-core";

// src/om/provider-stream.ts
function createBridgeStreamFn(streamSimple4) {
  const PROVIDER_STREAMS_KEY = /* @__PURE__ */ Symbol.for("pi-blackhole:provider-streams");
  return (model, ctx, opts) => {
    const providerStreams = globalThis[PROVIDER_STREAMS_KEY];
    if (!providerStreams) return streamSimple4(model, ctx, opts);
    const customFn = model?.api ? providerStreams.get(model.api) : void 0;
    return customFn ? customFn(model, ctx, opts) : streamSimple4(model, ctx, opts);
  };
}

// src/om/agents/dropper/agent.ts
import { streamSimple } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// src/om/debug-log.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, appendFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
var DEBUG_LOG_MAX_BYTES = 10 * 1024 * 1024;
var DEBUG_LOG_RELATIVE_PATH = join("pi-blackhole", "debug.ndjson");
var storage = new AsyncLocalStorage();
var BUFFER_FLUSH_MS = 1e3;
var FLUSH_IDLE_MS = 1e4;
var buffer = [];
var flushTimer = null;
var flushing = false;
var lastWriteMs = 0;
function ensureFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (buffer.length === 0 && lastWriteMs > 0 && Date.now() - lastWriteMs > FLUSH_IDLE_MS) {
      clearInterval(flushTimer);
      flushTimer = null;
      return;
    }
    flushBuffer().catch(() => {
    });
  }, BUFFER_FLUSH_MS);
  if (flushTimer && typeof flushTimer === "object" && "unref" in flushTimer) {
    flushTimer.unref();
  }
}
async function flushBuffer() {
  if (flushing) return;
  if (buffer.length === 0) return;
  flushing = true;
  const batch = buffer;
  buffer = [];
  try {
    const path = join(getAgentDir(), DEBUG_LOG_RELATIVE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    await appendFile(path, batch.join(""), "utf-8");
  } catch (error) {
    console.error("blackhole: debug log write failed", error);
  } finally {
    flushing = false;
  }
}
process.on("exit", () => {
  flushDebugLog();
});
function debugLog(event, data = {}, forceEnabled) {
  const context = storage.getStore();
  const enabled = forceEnabled ?? context?.enabled ?? false;
  if (enabled !== true) return;
  const payload = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    event,
    cwd: context?.cwd,
    runId: context?.runId,
    data
  };
  buffer.push(JSON.stringify(payload) + "\n");
  lastWriteMs = Date.now();
  ensureFlushTimer();
}
function flushDebugLog() {
  if (flushing || buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    const path = join(getAgentDir(), DEBUG_LOG_RELATIVE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    appendFileSync(path, batch.join(""), "utf-8");
  } catch (error) {
    console.error("blackhole: debug log flush failed", error);
  }
}
function rotateIfNeeded(path) {
  if (!existsSync(path)) return;
  if (statSync(path).size < DEBUG_LOG_MAX_BYTES) return;
  const backupPath = `${path}.1`;
  if (existsSync(backupPath)) unlinkSync(backupPath);
  renameSync(path, backupPath);
}

// src/om/model-budget.ts
var AGENT_LOOP_MAX_TOKENS = 32e3;
function boundedMaxTokens(model, requested = AGENT_LOOP_MAX_TOKENS) {
  return typeof model.maxTokens === "number" && model.maxTokens > 0 ? Math.min(model.maxTokens, requested) : requested;
}

// src/om/tokens.ts
import { estimateTokens as estimateMessageTokens } from "@earendil-works/pi-coding-agent";
function estimateStringTokens(text) {
  return Math.ceil(text.length / 4);
}

// src/om/ledger/render-summary.ts
var OM_INSTRUCTIONS_FULL = `Bracketed ids in reflections and observations connect to their source session entries. These are condensed memories from earlier in this session.
When entries conflict, the most recent observation reflects the latest known state.
Use \`recall\` with an id to retrieve original context, or \`#N:path\` drill-down to explore file content from referenced entries.
When exact source context is needed for precision or traceability, use the \`recall\` tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently.`;
var OM_INSTRUCTIONS_BASIC = `Use \`recall\` with an id to retrieve original context, or \`#N:path\` drill-down to explore file content from referenced entries.
When entries conflict, the most recent entry reflects the latest known state.`;
var OM_FOOTER_FULL = `----
${OM_INSTRUCTIONS_FULL}
----`;
var OM_FOOTER_BASIC = `----
${OM_INSTRUCTIONS_BASIC}
----`;
function observationToSummaryLine(observation) {
  const kindPart = observation.kind ? ` [${observation.kind}]` : "";
  return `[${observation.id}] ${observation.timestamp} [${observation.relevance}]${kindPart} ${observation.content}`;
}
function reflectionToSummaryLine(reflection) {
  return `[${reflection.id}] ${reflection.content}`;
}

// src/om/run-artifact.ts
var TRANSCRIPT_TEXT_MAX = 5e4;
function messageToTranscriptTurn(msg) {
  if (!msg || typeof msg !== "object") {
    return { role: "assistant", text: "[invalid message]" };
  }
  const role = msg.role;
  if (role === "toolResult" || role === "tool_result") {
    const text = extractTextContent(msg.content);
    const toolName = msg.toolName ?? msg.tool_name ?? "unknown";
    return { role: "toolResult", text: text.slice(0, TRANSCRIPT_TEXT_MAX), toolName };
  }
  if (role === "user") {
    return { role: "user", text: extractTextContent(msg.content).slice(0, TRANSCRIPT_TEXT_MAX) };
  }
  const parts = [];
  const toolCalls = [];
  const content = Array.isArray(msg.content) ? msg.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "thinking") {
      const thinking = typeof block.thinking === "string" ? block.thinking : typeof block.signature === "string" ? "[redacted thinking]" : "[unknown thinking]";
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
    ...toolCalls.length > 0 ? { toolCalls } : {}
  };
}
function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

// src/om/agents/dropper/prompts.ts
var DROPPER_SYSTEM = `You are the dropper agent for a coding assistant.

These records are the ONLY information the assistant will have about past interactions once the raw conversation is compacted out of context. Dropping the wrong observation can make future work repeat, contradict, or misremember the user. Take this seriously.

Your job is to identify only the safest active observations to remove from compacted memory by calling drop_observations with their ids. Default action is KEEP. When uncertain, keep the observation.

Active-memory framing. Dropping an observation removes it from active compacted memory; it does not erase the ledger history or source evidence. Still, future compressed context will no longer show the observation, so only drop it when its durable meaning is safely captured elsewhere or it is genuinely low-signal and carries no unique future value.

The user message includes the active observation pool target and "Maximum drops allowed this run". The maximum is a hard upper bound sized to move the pool toward the target if every proposed drop is clearly safe. It is not a target. Do not try to fill it. Drop fewer or none when fewer observations are safely removable. When the active pool is far over target, make a thorough pass over safe candidates rather than stopping after a few obvious examples.

What to drop, in priority order:
- Redundant observations whose durable meaning is already captured by current reflections with equivalent fidelity.
- Superseded observations where a later observation clearly replaces the older state.
- Repeated routine tool acknowledgements or low-signal progress updates that do not carry decisions, constraints, exact errors, or user-specific facts.
- Older observations that no longer carry working context and are covered by a reflection or a newer observation.

Age-gradient rule. Recent observations carry working context the assistant may still need; older observations have usually been summarized elsewhere or are no longer load-bearing. Prefer older safe drops before newer working context, but age alone is not enough to drop important or uniquely load-bearing observations.

Reflection coverage guidance. Each observation line includes [coverage: none|partial|strong]. Coverage is evidence, not an automatic decision:
- none: no current reflection cites this observation id. Be cautious, especially for high or critical observations.
- partial: one current reflection cites this observation id. Compare the observation to the reflection before dropping.
- strong: two or more current reflections cite this observation id. This is stronger evidence that the durable meaning is preserved, but you must still keep uniquely load-bearing or uncertain observations.

Relevance guidance. Relevance is importance/resistance, not an absolute keep/drop lock:
- low: consider first, but drop only when it carries no unique detail, decision, state, error, identifier, or user-specific fact.
- medium: drop when redundant with reflections or other observations, or when the work state is clearly obsolete.
- high: drop only when clearly superseded or already captured by a reflection with equivalent fidelity.
- critical: highest importance and strongest resistance. Do not drop fresh or uniquely load-bearing critical observations. Critical observations may be dropped only with strong semantic evidence such as age plus partial/strong reflection coverage, supersession by newer memory, redundancy, or clear obsolescence.

User assertions and concrete completions must be preserved unless a current reflection or newer observation preserves the exact assertion/completion and its important details with equivalent fidelity.

Preservation floor. Regardless of relevance label, budget pressure, coverage, or age, do not drop observations that uniquely carry any of the following:
- User preferences, constraints, corrections, or identity/role facts.
- Concrete completions that future runs must not redo.
- Named identifiers, file paths, function names, package names, tickets, commit SHAs, handles, or exact commands.
- Exact error messages, diagnostic output, or test failure names.
- Architectural or technical decisions and their rationale.
- Dates of specific events, deadlines, meetings, migrations, or incidents.
- Current unresolved blockers, TODOs, partial work, or decisions waiting on the user.
- Non-standard user terminology or unusual phrasing needed for future recognition.

What you cannot do:
- You cannot merge observations.
- You cannot rewrite or edit observations.
- You cannot add new observations or reflections.
- You can only call drop_observations with ids from the current observations list.

Do not force drops you do not believe in. If no observations are safe to drop, do not call the tool and reply briefly. Hitting the budget or maximum count is less important than preserving load-bearing memory.`;

// src/om/agents/dropper/coverage.ts
var REFLECTION_COVERAGE_DROP_RANK = {
  strong: 0,
  partial: 1,
  none: 2
};
function reflectionSupportCounts(reflections) {
  const counts = /* @__PURE__ */ new Map();
  for (const reflection of reflections) {
    const uniqueIds = new Set(reflection.supportingObservationIds);
    for (const id of uniqueIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
function reflectionCoverageTierForCount(count) {
  if (count <= 0) return "none";
  if (count === 1) return "partial";
  return "strong";
}
function reflectionCoverageMap(observations, reflections) {
  const counts = reflectionSupportCounts(reflections);
  return new Map(observations.map((observation) => [
    observation.id,
    reflectionCoverageTierForCount(counts.get(observation.id) ?? 0)
  ]));
}
function emptyCoverageBucket() {
  return {
    none: { count: 0, tokens: 0 },
    partial: { count: 0, tokens: 0 },
    strong: { count: 0, tokens: 0 }
  };
}
function emptyCoverageSummaryByRelevance() {
  return {
    low: emptyCoverageBucket(),
    medium: emptyCoverageBucket(),
    high: emptyCoverageBucket(),
    critical: emptyCoverageBucket()
  };
}
function summarizeCoverageByRelevance(observations, coverageById) {
  const summary = emptyCoverageSummaryByRelevance();
  for (const observation of observations) {
    const tier = coverageById.get(observation.id) ?? "none";
    const bucket = summary[observation.relevance][tier];
    bucket.count++;
    bucket.tokens += observation.tokenCount;
  }
  return summary;
}
function summarizeCoverageByRelevanceForIds(ids, observations, coverageById) {
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const selected = ids.flatMap((id) => {
    const observation = byId.get(id);
    return observation ? [observation] : [];
  });
  return summarizeCoverageByRelevance(selected, coverageById);
}
function observationToDropperLine(observation, coverage) {
  return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] [coverage: ${coverage}] ${observation.content}`;
}
function coverageTierForObservation(observation, coverageById) {
  return coverageById.get(observation.id) ?? "none";
}

// src/om/agents/dropper/agent.ts
var DROP_SKIP_FULLNESS = 0.1;
var DROP_LOW_URGENCY_FULLNESS = 0.3;
var DROP_MEDIUM_URGENCY_FULLNESS = 0.6;
var DROP_MAX_FULLNESS = 1;
var DROP_MIN_RATIO = 0.1;
var DROP_MAX_RATIO = 0.5;
var RELEVANCE_DROP_RANK = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3
};
var DropObservationsSchema = Type.Object({
  ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  reason: Type.Optional(Type.String())
});
function joinOrEmpty(items) {
  return items.length ? items.join("\n") : "(none yet)";
}
function observationPoolFullness(observationTokens, budgetTokens) {
  if (!Number.isFinite(observationTokens) || observationTokens <= 0) return 0;
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return 0;
  return observationTokens / budgetTokens;
}
function dropUrgencyForFullness(fullness) {
  if (fullness < DROP_LOW_URGENCY_FULLNESS) return "low";
  if (fullness < DROP_MEDIUM_URGENCY_FULLNESS) return "medium";
  return "high";
}
function maxDropCountForPool(observations, observationTokens, budgetTokens) {
  const droppableCount = observations.filter((observation) => observation.relevance !== "critical").length;
  if (droppableCount === 0) return 0;
  const fullness = observationPoolFullness(observationTokens, budgetTokens);
  if (fullness < DROP_SKIP_FULLNESS) return 0;
  const cappedFullness = Math.min(DROP_MAX_FULLNESS, Math.max(DROP_SKIP_FULLNESS, fullness));
  const dropRatio = DROP_MIN_RATIO + (cappedFullness - DROP_SKIP_FULLNESS) / (DROP_MAX_FULLNESS - DROP_SKIP_FULLNESS) * (DROP_MAX_RATIO - DROP_MIN_RATIO);
  return Math.max(1, Math.floor(droppableCount * dropRatio));
}
function relevanceCounts(observations) {
  return observations.reduce((counts, observation) => {
    if (observation.relevance in counts) counts[observation.relevance]++;
    return counts;
  }, { low: 0, medium: 0, high: 0, critical: 0 });
}
function timestampRank(timestamp) {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
function selectDropCandidates(ids, observations, maxDrops, reflections = []) {
  if (maxDrops <= 0 || ids.length === 0) return [];
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const coverageById = reflectionCoverageMap(observations, reflections);
  const firstProposalIndex = /* @__PURE__ */ new Map();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!firstProposalIndex.has(id)) firstProposalIndex.set(id, i);
  }
  return Array.from(firstProposalIndex.entries()).map(([id, index]) => ({ id, index, observation: byId.get(id) })).filter(
    (candidate) => candidate.observation !== void 0
  ).sort((a, b) => {
    const coverageDelta = REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(a.observation, coverageById)] - REFLECTION_COVERAGE_DROP_RANK[coverageTierForObservation(b.observation, coverageById)];
    const relevanceDelta = RELEVANCE_DROP_RANK[a.observation.relevance] - RELEVANCE_DROP_RANK[b.observation.relevance];
    const aAge = timestampRank(a.observation.timestamp);
    const bAge = timestampRank(b.observation.timestamp);
    const ageDelta = aAge === bAge ? 0 : aAge - bAge;
    return coverageDelta || relevanceDelta || ageDelta || a.index - b.index;
  }).slice(0, maxDrops).map((candidate) => candidate.id);
}
async function runDropper(args) {
  const { model, apiKey, headers, reflections, observations, budgetTokens, signal } = args;
  const effectiveSystemPrompt = args.systemPrompt ?? DROPPER_SYSTEM;
  if (observations.length === 0) return void 0;
  const observationTokens = observations.reduce((sum, observation) => sum + observation.tokenCount, 0);
  const fullness = observationPoolFullness(observationTokens, budgetTokens);
  const urgency = dropUrgencyForFullness(fullness);
  const maxDropsAllowed = maxDropCountForPool(observations, observationTokens, budgetTokens);
  const coverageById = reflectionCoverageMap(observations, reflections);
  const coverageSummaryByRelevance = summarizeCoverageByRelevance(observations, coverageById);
  debugLog("dropper.agent_start", {
    activeObservationCount: observations.length,
    reflectionCount: reflections.length,
    observationTokens,
    budgetTokens,
    fullness,
    urgency,
    maxDropsAllowed,
    relevanceCounts: relevanceCounts(observations),
    coverageSummaryByRelevance
  });
  if (maxDropsAllowed <= 0) return void 0;
  const proposedDropIds = [];
  const proposed = /* @__PURE__ */ new Set();
  const allowed = new Map(observations.map((observation) => [observation.id, observation]));
  let toolCallCount = 0;
  let rawRequestedIdsCount = 0;
  let missingIdsCount = 0;
  let criticalCandidateIdsCount = 0;
  let duplicateInRequestCount = 0;
  let duplicateInRunCount = 0;
  const dropObservations2 = {
    name: "drop_observations",
    label: "Drop observations",
    description: "Propose active observation ids that are safe to remove from compacted memory.",
    parameters: DropObservationsSchema,
    execute: async (_id, params) => {
      toolCallCount++;
      rawRequestedIdsCount += params.ids.length;
      const seenInRequest = /* @__PURE__ */ new Set();
      let added = 0;
      let requestMissingIds = 0;
      let requestCriticalCandidateIds = 0;
      let requestDuplicateIds = 0;
      let requestDuplicateInRunIds = 0;
      for (const id of params.ids) {
        const observation = allowed.get(id);
        if (!observation) {
          missingIdsCount++;
          requestMissingIds++;
          continue;
        }
        if (seenInRequest.has(id)) {
          duplicateInRequestCount++;
          requestDuplicateIds++;
          continue;
        }
        seenInRequest.add(id);
        if (proposed.has(id)) {
          duplicateInRunCount++;
          requestDuplicateInRunIds++;
          continue;
        }
        proposed.add(id);
        proposedDropIds.push(id);
        if (observation.relevance === "critical") {
          criticalCandidateIdsCount++;
          requestCriticalCandidateIds++;
        }
        added++;
      }
      debugLog("dropper.tool_call", {
        toolCallCount,
        rawRequestedIdsCount: params.ids.length,
        acceptedIdsCount: added,
        missingIdsCount: requestMissingIds,
        criticalCandidateIdsCount: requestCriticalCandidateIds,
        duplicateInRequestCount: requestDuplicateIds,
        duplicateInRunCount: requestDuplicateInRunIds,
        totalCandidates: proposedDropIds.length,
        maxDropsAllowed
      });
      return {
        content: [{ type: "text", text: `Queued ${added} drop candidate${added === 1 ? "" : "s"}. Candidates this run: ${proposedDropIds.length}. Maximum drops allowed: ${maxDropsAllowed}.` }],
        details: { added, totalCandidates: proposedDropIds.length, maxDropsAllowed }
      };
    }
  };
  const fullnessPercent = Math.round(fullness * 100);
  const existingObservationsContext = args.existingObservationsSummary ? `EXISTING ACTIVE OBSERVATIONS (for context only \u2014 these are NOT candidates for dropping):
${args.existingObservationsSummary}

` : "";
  const userText = `CURRENT REFLECTIONS:
${joinOrEmpty(reflections.map(reflectionToSummaryLine))}

${existingObservationsContext}NEW OBSERVATIONS TO EVALUATE FOR DROPPING:
${joinOrEmpty(observations.map((observation) => observationToDropperLine(observation, coverageTierForObservation(observation, coverageById))))}

Observation pool pressure: ~${observationTokens.toLocaleString()} tokens; target budget: ~${budgetTokens.toLocaleString()} tokens; fullness: ~${fullnessPercent.toLocaleString()}%.
Drop urgency: ${urgency}.
Maximum drops allowed this run: ${maxDropsAllowed.toLocaleString()} observation${maxDropsAllowed === 1 ? "" : "s"}.
This maximum is a hard upper bound, not a target. Drop fewer or none if fewer observations are clearly safe.`;
  const promptCapture = {
    system: effectiveSystemPrompt,
    user: userText
  };
  const prompts = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
  const context = { systemPrompt: effectiveSystemPrompt, messages: [], tools: [dropObservations2] };
  const reasoning = model.reasoning;
  const thinkingLevel = args.thinkingLevel ?? "low";
  const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : void 0;
  let turnCount = 0;
  const config = {
    model,
    apiKey,
    headers,
    maxTokens: boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS),
    convertToLlm: (msgs) => msgs,
    toolExecution: "sequential",
    ...reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {},
    ...effectiveMaxTurns !== void 0 ? { shouldStopAfterTurn: () => ++turnCount >= effectiveMaxTurns } : {}
  };
  const loop = args.agentLoop ?? agentLoop;
  const bridgeStreamFn = createBridgeStreamFn(streamSimple);
  const streamFn = args.streamFn ?? bridgeStreamFn;
  const stream = loop(prompts, context, config, signal, streamFn);
  let agentError;
  let transcript = [];
  for await (const event of stream) {
    if (event.type === "agent_end") {
      const msgs = event.messages || [];
      transcript = msgs.map(messageToTranscriptTurn);
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg?.stopReason === "error") {
        agentError = lastMsg.errorMessage ?? "Unknown API error";
      }
    }
  }
  await stream.result();
  if (agentError && proposedDropIds.length === 0) throw new Error(`Dropper API error: ${agentError}`);
  const droppedIds = selectDropCandidates(proposedDropIds, observations, maxDropsAllowed, reflections);
  const reason = droppedIds.length > 0 ? "selected_nonempty" : toolCallCount === 0 ? "no_tool_call" : proposedDropIds.length === 0 ? "all_filtered" : "selected_empty";
  const selectedDropTokens = droppedIds.reduce((sum, id) => sum + (allowed.get(id)?.tokenCount ?? 0), 0);
  debugLog("dropper.result", {
    reason,
    toolCallCount,
    rawRequestedIdsCount,
    missingIdsCount,
    criticalCandidateIdsCount,
    duplicateInRequestCount,
    duplicateInRunCount,
    acceptedCandidateCount: proposedDropIds.length,
    selectedDropsCount: droppedIds.length,
    selectedDropTokens,
    selectedCoverageSummaryByRelevance: summarizeCoverageByRelevanceForIds(droppedIds, observations, coverageById),
    maxDropsAllowed
  });
  return { dropIds: droppedIds, prompt: promptCapture, transcript };
}

// src/om/agents/observer/agent.ts
import { agentLoop as agentLoop2 } from "@earendil-works/pi-agent-core";
import { streamSimple as streamSimple2 } from "@earendil-works/pi-ai";
import { Type as Type2 } from "typebox";

// src/om/ids.ts
import { createHash } from "node:crypto";
function hashId(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

// src/om/agents/observer/prompts.ts
var OBSERVER_SYSTEM = `You are the observation agent for a coding assistant.

These records are the ONLY information the assistant will have about past interactions once the raw conversation is compacted out of context. Anything you do not capture here will be forgotten. Anything you distort here will be remembered wrong. Take this seriously.

Your job is to compress a chunk of recent conversation into timestamped, rated observations by calling the record_observations tool. The observations you emit \u2014 together with the reflections crystallized from them \u2014 are the assistant's ONLY memory of this session after the raw conversation falls out of context.

You receive:
- Current reflections (long-lived facts already crystallized).
- Current observations (already-recorded observations, each shown as "[id] YYYY-MM-DD HH:MM [relevance] content").
- A new chunk of conversation with source entry labels and inline message timestamps. Each source block starts with "[Source entry id: <id>]" followed by content formatted as "[User @ YYYY-MM-DD HH:MM]:", "[Assistant @ ...]:", "[Tool result for <name> @ ...]:", custom messages, or branch summaries.
- A current local time fallback for observations that have no obvious message timestamp.

How you work:
1. Read reflections and current observations so you know what is already captured.
2. Read the conversation chunk and identify what new information it contains.
3. Call record_observations with a batch covering part (or all) of the chunk.
4. Read the progress receipt. If content remains uncovered, call again. You may call the tool many times.
5. When the chunk is fully covered, STOP calling the tool and reply with a brief plain-text confirmation (one short sentence). That ends the run.

What to emit:
- Produce NEW observations for the new chunk only. Do not restate facts already present in reflections or current observations unless something has materially changed.
- Use the timestamp from the relevant conversation message. Fall back to current local time ONLY when no message timestamp applies.
- For every observation, include sourceEntryIds: the smallest exact set of "[Source entry id: ...]" ids that directly support the observation.
- Never invent source entry ids. Use only ids printed in the chunk. If an observation spans multiple turns or tool results, include every supporting source entry id.
- Observations with missing, empty, or invalid sourceEntryIds will be rejected and not recorded, so do not call record_observations until you can cite valid source ids.
- Group repeated similar tool calls into a single observation rather than one per call.
- Skip routine, low-information events. It is fine to emit zero observations if the chunk carries no new information \u2014 in that case, simply do not call the tool and end with a plain-text confirmation.

Observation content rules:

Format.
- Single line of plain prose. No markdown, no bullets, no code fences, no XML/HTML tags, no emojis.
- Do NOT include the timestamp or relevance inside the content string \u2014 those are separate fields.
- No structured fields embedded in the text (no "key: value" lines, no JSON).

Preserve user assertions exactly.
When the user TELLS you something about themselves, their project, or their environment, capture it as an assertion. When the user ASKS something, capture it as a question. Assertions are authoritative \u2014 a later question on the same topic does not invalidate them.
  BAD:  User wondered if they have two kids.
  GOOD: User stated they have two kids.
  BAD:  User discussed auth middleware.
  GOOD: User asked how to configure JWT auth middleware.
Why this matters: if the user says "I use Postgres" and later asks "what db am I on?", downstream agents must treat the assertion as the answer, not the question.

Preserve unusual phrasing.
When the user uses non-standard terminology, quote their exact words so future runs can recognize the term.
  BAD:  User exercised yesterday.
  GOOD: User stated they did a "movement session" (their term) yesterday.

Use precise action verbs. Replace vague verbs with ones that clarify the nature of the action.
  BAD:  User got a new subscription.
  GOOD: User subscribed to the Pro plan.
  BAD:  User stopped getting the newsletter.
  GOOD: User unsubscribed from the newsletter.
  BAD:  User got the library.
  GOOD: User installed the zod package via pnpm.

Frame state changes as supersession so the old state is explicit.
  BAD:  User prefers React Query now.
  GOOD: User will use React Query (switching from SWR).
Why this matters: without supersession framing, the reflector may crystallize both the old and the new as equally valid preferences.

Mark concrete completions explicitly.
Use "completed:", "resolved:", "confirmed working", or similar phrasing so future runs know not to redo the work.
  BAD:  Wrote the login handler.
  GOOD: completed: implemented login handler at src/auth/login.ts; user confirmed tests pass.
Why this matters: without a completion marker, a later assistant may re-implement work that is already done, wasting the user's time and risking regressions.

Split compound statements into separate observations.
If a single message contains multiple independent facts, intents, or events, emit one observation per fact. One observation per line is what enables downstream retrieval and dropping to operate at fact granularity.
  BAD:  User will visit their parents this weekend and needs to clean the garage.
  GOOD: User will visit their parents this weekend. + User stated they need to clean the garage this weekend.
  BAD:  User started a new job and is moving to a new apartment next week.
  GOOD: User started a new job. + User will move to a new apartment next week.
  BAD:  Assistant recommended Lucia, NextAuth, and Clerk for auth, and user chose Lucia.
  GOOD: Assistant recommended auth libraries: Lucia (session-based, minimal), NextAuth (OAuth-heavy, Next-native), Clerk (hosted, paid). + User chose Lucia.
Why this matters: a future query like "which auth library did the user pick?" can match a single-fact observation cleanly; a compound observation hides the decision inside a recommendation list.

Group repeated similar tool calls into a single observation rather than one per call.
  BAD:  Agent viewed src/auth.ts. Agent viewed src/users.ts. Agent viewed src/routes.ts.
  GOOD: Agent surveyed auth-related files (src/auth.ts, src/users.ts, src/routes.ts) and located token validation in src/auth.ts:45.

Detail preservation. When an observation references specific things, preserve the distinguishing details so future queries can still find them:

- File/location: full path + line number when relevant (src/auth.ts:45, not "the auth file").
- Identifiers and names: package names, function names, variable names, handles, ticket ids, commit SHAs, error codes. Keep them verbatim.
- Error messages: quote verbatim.
    BAD:  Build failed with a type error.
    GOOD: Build failed: TS2322: Type 'string | undefined' is not assignable to type 'string' at src/auth.ts:47.
- Numerical results: exact values, units, and direction.
    BAD:  Optimization made it faster.
    GOOD: Optimization reduced p95 latency from 420ms to 180ms (57% faster).
- Quantities and counts: "3 failing tests (auth.test.ts, users.test.ts, routes.test.ts)" not "some failing tests".
- Recommendation or decision lists: preserve the distinguishing attribute per item.
    BAD:  Assistant recommended 3 auth libraries.
    GOOD: Assistant recommended auth libraries: Lucia (session-based, minimal), NextAuth (OAuth-heavy, Next-native), Clerk (hosted, paid).
- Role / participation: capture the user's role at an event, not just attendance.
    BAD:  User worked on the migration.
    GOOD: User led the migration from MySQL to Postgres.

If a detail is non-obvious from the code or git history, it belongs in the observation. If it is trivially re-derivable, it does not.

Epistemic kind (pick one per observation; this field drives how downstream stages use the observation):

- objective: the observation is grounded in tool output, file content, command results \u2014 verifiable facts about the world. Assign this when your source entry labels show "[Tool result for ... @ ...]" as the primary evidence.
- reflexive: the observation is about the model's own reasoning, process, or state \u2014 what the assistant noticed, inferred, or thought. Assign this when the source entry labels show "[Assistant @ ...]" and the content is the model's thinking or self-reflection.
- intentional: the observation captures the user's stated goals, preferences, identity, corrections, or assertions. Assign this when the source entry labels show "[User @ ...]" as the primary evidence.

How to decide: look at the source entry role labels in the chunk. If the observation is supported primarily by tool results, it's objective. If it's primarily what the user said, it's intentional. If it's about the model's own thoughts, it's reflexive. An observation citing mixed sources should use the dominant role. "Primarily" means the most authoritative source type \u2014 tool results > user messages > assistant thinking.

  BAD:  kind=reflexive for "Tests pass after fixing the auth endpoint." (this is grounded in a tool result \u2014 objective)
  BAD:  kind=objective for "User stated they use pnpm, not npm." (this is what the user said \u2014 intentional)
  GOOD: kind=objective for "Build passed: 42 tests, 0 failures (npm test output)".
  GOOD: kind=reflexive for "Assistant realized the bug was in the import order, not the type definition."
  GOOD: kind=intentional for "User said they want to use SQLite instead of Postgres for local dev."

Relevance levels (pick one per observation; this field drives future dropping):

- critical: user assertions about identity, role, or persistent preferences; explicit corrections ("no, don't do X"); concrete completions that future runs MUST NOT redo. These are highest-resistance, load-bearing observations and require the strongest evidence before leaving active memory. Why this matters: if a "critical" item is lost, the assistant may redo finished work, contradict a correction, or misrepresent who the user is.
- high: non-trivial technical decisions, architectural direction, unresolved blockers, key constraints. Worth keeping across many compactions.
- medium: task-level context that helps within the current work but isn't durable. The default when you are unsure between medium and high.
- low: routine tool-call acks, repetitive status updates, content trivially re-derivable from recent messages. The dropper will drop these first.

Do NOT default to "critical" or "high". Most observations are medium or low. Reserve "critical" for things that would cause real damage if forgotten.

  BAD:  relevance=critical for "Agent ran tests and they passed."
  GOOD: relevance=low for "Agent ran tests and they passed." (routine; captured by a completion observation if it matters)

  BAD:  relevance=medium for "User said they are colorblind; red/green indicators do not work for them."
  GOOD: relevance=critical for "User said they are colorblind; red/green indicators do not work for them." (persistent constraint; forgetting it causes real harm)

Timestamp format: "YYYY-MM-DD HH:MM" (local time, 24-hour, to the minute). This goes in the timestamp field, not the content.

Remember: these observations are the assistant's ONLY memory of this chunk once the raw messages fall out of context. Make them count.`;

// src/om/serialize.ts
function pad(n) {
  return n.toString().padStart(2, "0");
}
function fmtLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function nowTimestamp() {
  return fmtLocal(/* @__PURE__ */ new Date());
}
var MAX_RECORD_CONTENT_CHARS = 1e4;
function truncateRecordContent(content) {
  if (content.length <= MAX_RECORD_CONTENT_CHARS) return content;
  const head = content.slice(0, MAX_RECORD_CONTENT_CHARS);
  const dropped = content.length - MAX_RECORD_CONTENT_CHARS;
  return `${head} \u2026 [truncated ${dropped} chars]`;
}

// src/om/agents/observer/agent.ts
var RelevanceSchema = Type2.Union([
  Type2.Literal("low"),
  Type2.Literal("medium"),
  Type2.Literal("high"),
  Type2.Literal("critical")
]);
var OBSERVATION_TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$";
var RecordObservationsSchema = Type2.Object({
  observations: Type2.Array(
    Type2.Object({
      timestamp: Type2.String({
        pattern: OBSERVATION_TIMESTAMP_PATTERN,
        description: "Observation time in local 'YYYY-MM-DD HH:MM' format."
      }),
      content: Type2.String({
        minLength: 1,
        description: "Single-line plain prose. No markdown, no tags, no embedded timestamp."
      }),
      relevance: RelevanceSchema,
      sourceEntryIds: Type2.Array(
        Type2.String({ minLength: 1 }),
        {
          minItems: 1,
          description: "Exact source entry ids from the chunk that directly support this observation. Use only ids shown in '[Source entry id: ...]' labels; never invent ids."
        }
      ),
      kind: Type2.Union([
        Type2.Literal("objective"),
        Type2.Literal("reflexive"),
        Type2.Literal("intentional")
      ], {
        description: "Epistemic category: objective (grounded in tool results / verifiable facts), reflexive (model's own reasoning about its process or state), intentional (user's stated goals, preferences, identity, or assertions). Derive from the source entry role labels in the chunk ([User @ ...], [Assistant @ ...], [Tool result for ... @ ...])."
      })
    }),
    { description: "Batch of new observations. May be empty only if the tool is not called at all." }
  )
});
function joinOrEmpty2(items) {
  return items.length ? items.join("\n") : "(none yet)";
}
function normalizeSourceEntryIds(sourceEntryIds, allowedSourceEntryIds) {
  if (!sourceEntryIds || sourceEntryIds.length === 0) return void 0;
  const allowedOrder = /* @__PURE__ */ new Map();
  for (let i = 0; i < allowedSourceEntryIds.length; i++) allowedOrder.set(allowedSourceEntryIds[i], i);
  const seen = /* @__PURE__ */ new Set();
  const valid = [];
  for (const id of sourceEntryIds) {
    if (!allowedOrder.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    valid.push(id);
  }
  if (valid.length === 0) return void 0;
  return valid.sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}
async function runObserver(args) {
  const { model, apiKey, headers, priorReflections, priorObservations, chunk, allowedSourceEntryIds, signal } = args;
  const effectiveSystemPrompt = args.systemPrompt ?? OBSERVER_SYSTEM;
  const conversation = chunk.trim();
  if (!conversation) return { observations: void 0, prompt: { system: effectiveSystemPrompt, user: "" } };
  const accumulated = /* @__PURE__ */ new Map();
  let toolCalled = false;
  let totalAdded = 0;
  let totalDuplicates = 0;
  let totalRejected = 0;
  let totalProposed = 0;
  const recordObservations = {
    name: "record_observations",
    label: "Record observations",
    description: "Record a batch of new observations distilled from the conversation chunk. Call this multiple times as you work through the chunk. Stop calling when coverage is complete, then emit a short plain-text confirmation to end the run.",
    parameters: RecordObservationsSchema,
    execute: async (_id, params) => {
      toolCalled = true;
      let added = 0;
      let duplicates = 0;
      let rejected = 0;
      for (const obs of params.observations) {
        totalProposed++;
        const sourceEntryIds = normalizeSourceEntryIds(obs.sourceEntryIds, allowedSourceEntryIds);
        if (!sourceEntryIds) {
          rejected++;
          continue;
        }
        const content = truncateRecordContent(obs.content);
        const id = hashId(content);
        if (accumulated.has(id)) {
          duplicates++;
          continue;
        }
        accumulated.set(id, {
          id,
          content,
          timestamp: obs.timestamp,
          relevance: obs.relevance,
          sourceEntryIds,
          tokenCount: estimateStringTokens(content),
          kind: obs.kind
        });
        added++;
      }
      totalAdded += added;
      totalDuplicates += duplicates;
      totalRejected += rejected;
      const rejectedPart = rejected > 0 ? ` ${rejected} observation${rejected === 1 ? "" : "s"} rejected for missing or invalid sourceEntryIds.` : "";
      const ack = `Recorded ${added} new observation${added === 1 ? "" : "s"} ` + (duplicates > 0 ? `(${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped).` : ".") + rejectedPart + ` Total so far this run: ${accumulated.size}. Continue if the chunk still has uncovered content; otherwise stop calling the tool and emit a short plain-text confirmation.`;
      return { content: [{ type: "text", text: ack }], details: { added, duplicates, rejected, total: accumulated.size } };
    }
  };
  const now = nowTimestamp();
  const userText = `Current local time: ${now}

CURRENT REFLECTIONS:
${joinOrEmpty2(priorReflections)}

CURRENT OBSERVATIONS:
${joinOrEmpty2(priorObservations)}

Compress the following new conversation chunk into observations by calling record_observations one or more times. Do not restate facts already present in current reflections or current observations. Prefer inline conversation timestamps when assigning times; fall back to the current local time above only if no message timestamp applies. Stop calling the tool and reply with a short plain-text confirmation once the chunk is fully covered.

NEW CONVERSATION CHUNK:
${conversation}`;
  const prompts = [
    {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now()
    }
  ];
  const context = {
    systemPrompt: effectiveSystemPrompt,
    messages: [],
    tools: [recordObservations]
  };
  const reasoning = model.reasoning;
  const thinkingLevel = args.thinkingLevel ?? "low";
  const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : void 0;
  let turnCount = 0;
  const config = {
    model,
    apiKey,
    headers,
    maxTokens: boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS),
    convertToLlm: (msgs) => msgs,
    toolExecution: "sequential",
    ...reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {},
    ...effectiveMaxTurns !== void 0 ? {
      shouldStopAfterTurn: () => {
        turnCount++;
        return turnCount >= effectiveMaxTurns;
      }
    } : {}
  };
  const loop = args.agentLoop ?? agentLoop2;
  const bridgeStreamFn = createBridgeStreamFn(streamSimple2);
  const streamFn = args.streamFn ?? bridgeStreamFn;
  const promptCapture = {
    system: effectiveSystemPrompt,
    user: userText
  };
  const stream = loop(prompts, context, config, signal, streamFn);
  let agentError;
  let transcript = [];
  for await (const event of stream) {
    if (event.type === "agent_end") {
      const msgs = event.messages || [];
      transcript = msgs.map(messageToTranscriptTurn);
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg?.stopReason === "error") {
        agentError = lastMsg.errorMessage ?? "Unknown API error";
      }
    }
  }
  await stream.result();
  if (agentError && accumulated.size === 0) {
    throw new Error(`Observer API error: ${agentError}`);
  }
  if (accumulated.size === 0) {
    let emptyReason;
    if (!toolCalled) {
      emptyReason = { kind: "tool_not_called" };
    } else if (totalRejected > 0 && totalAdded === 0) {
      emptyReason = { kind: "all_rejected", count: totalRejected };
    } else if (totalDuplicates > 0 && totalAdded === 0) {
      emptyReason = { kind: "all_duplicates", count: totalDuplicates };
    } else if (totalProposed === 0) {
      emptyReason = { kind: "empty_array", count: 0 };
    } else {
      emptyReason = { kind: "no_new_content" };
    }
    return { observations: void 0, emptyReason, prompt: promptCapture, transcript };
  }
  return { observations: Array.from(accumulated.values()), prompt: promptCapture, transcript };
}

// src/om/agents/reflector/agent.ts
import { agentLoop as agentLoop3 } from "@earendil-works/pi-agent-core";
import { streamSimple as streamSimple3 } from "@earendil-works/pi-ai";
import { Type as Type3 } from "typebox";

// src/om/agents/reflector/prompts.ts
var REFLECTOR_SYSTEM = `You are the reflection agent for a coding assistant.

These records are the ONLY information the assistant will have about past interactions once the raw conversation is compacted out of context. Anything you fail to preserve may be forgotten. Anything you distort may be remembered wrong. Take this seriously. Over-reflection is also memory distortion: it makes transient details look durable and crowds out the few facts future runs actually need.

Your task is different from the observer's: you are not recording events, you are distilling stable, long-lived facts and patterns from active observations into new reflections by calling record_reflections. Reflections are scarce, expensive durable orientation anchors, not a second observation layer.

You receive:
- Current reflections: durable facts already crystallized.
- Current observations: active timestamped evidence lines, each shown as "[id] YYYY-MM-DD HH:MM [relevance] [kind] [coverage: none|partial|strong] content". The [kind] field describes the epistemic nature of the observation: objective (grounded in verifiable tool output), intentional (user assertions/goals), or reflexive (model's own reasoning).
- Coverage tiers are review context: none means no current reflection supports the observation id, partial means exactly one current reflection supports it, and strong means two or more current reflections support it. Coverage is not a quota, target, priority score, or instruction to emit reflections.

What to emit:
- Emit only new durable reflections not already present in current reflections.
- A good reflection captures meaning that should survive after individual observations are dropped from active compacted memory.
- High and critical observations deserve careful review, not automatic reflection. Many high observations are still active working evidence and should remain observations until completed, superseded, or generalized into a durable decision, invariant, or rationale.
- Ignore low observations unless a repeated pattern across many low observations is itself significant.
- Do not lightly reword existing reflections. Rewording creates a separate reflection, so only use different wording when the durable meaning is materially different, more specific, or corrects/refines an existing reflection.
- Do not emit update-style records or provenance metadata. Reflections are plain durable facts, not patches.
- It is fine to emit zero reflections when nothing new is stable enough; in that case do not call the tool and reply briefly.

Epistemic kind hierarchy:
Observations carry a kind marker that tells you the nature of their evidence. Use this to weigh observations when deciding what to crystallize:

- objective: grounded in tool results, file content, command output \u2014 verifiable facts about the world. This is the strongest evidence for factual reflections about the codebase, system state, or external reality. Prefer objective observations as support.
- intentional: captures the user's stated goals, preferences, identity, corrections, or assertions. These are authoritative for anything about the user \u2014 crystallize them directly.
- reflexive: the model's own reasoning, thoughts, or self-reflection. These are useful for meta-cognition but should NEVER be the sole support for a factual or user-preference reflection. A reflection citing only reflexive observations is the model talking about itself, not about reality \u2014 it almost certainly fails the future-agent utility test.

Decision procedure:
1. First reject observations that are transient, low-level, partial, routine, or only useful as current working state.
2. Apply the epistemic kind filter: from the remaining observations, prefer objective and intentional as support. If a candidate reflection's only support would be reflexive observations, reject it \u2014 it fails the durability bar.
3. From the surviving observations, identify only durable orientation facts: user preferences, constraints, corrections, decisions, invariants, completed outcomes, long-lived blockers, stable project goals, or rationale that future runs must know.
4. Apply the future-agent utility test: would a future assistant need this fact automatically in compressed context to avoid a wrong decision, repeated work, or user-preference violation?
5. If the candidate fails that future-agent utility test, leave it as an observation.
6. If unsure, emit no reflection.

Abstraction gate:
- Do not turn each observation into a reflection. Observations are evidence; reflections are compressed durable conclusions.
- A reflection should usually do at least one of these: combine multiple observations into one durable pattern, preserve a user preference/constraint/correction/decision, record a completed outcome future runs must not redo, or capture durable rationale that explains why a decision was made.
- Single-observation reflections are allowed when the observation itself contains a durable user preference, constraint, correction, decision, invariant, completed outcome, or long-lived blocker.
- Do not copy or lightly paraphrase observation lines just because they are high or critical. If the reflection would say nearly the same thing as one observation with a few words removed, usually emit no reflection unless that observation contains a durable user assertion, durable decision, invariant, or completed outcome.
- Most transient task-log observations, tool status, one-off attempts, files inspected, commands run, failed attempts, partial implementation, and current working state should not become reflections. Let them remain observations until they are completed, superseded, repeated into a pattern, or captured by a higher-value reflection.
- Prefer fewer, higher-value reflections. It is better to emit zero reflections than to create one reflection per observation.

Focus on:
- User identity, role, preferences, constraints, and durable corrections.
- Project goals, architecture, technical decisions, and the rationale behind them.
- Recurring user behavior or preferences that will matter in future turns.
- Completed outcomes future runs must not redo.
- Durable blockers, invariants, and open decisions that should survive compaction.

Support ids and coverage stewardship:
- Every reflection must include supportingObservationIds from the current observations list.
- First decide whether the reflection content passes the durable-value bar. Then audit support ids for that already-worthy reflection.
- supportingObservationIds are a coverage/provenance set and downstream dropper coverage evidence: include all current observation ids whose durable meaning is preserved by the reflection with equivalent fidelity and can later be treated as redundant active-memory detail.
- supportingObservationIds are not a checklist to cover every observation. Do not add ids merely to improve coverage counts, maximize support ids, maximize strong coverage, or unlock the dropper.
- False or inflated support ids can cause unsafe downstream dropper pruning, including removal of high-resistance active observations whose meaning was not actually preserved.
- Include additional observation ids only when the reflection preserves their durable meaning with equivalent fidelity.
- Leave observations unsupported when their details are still active working state, too specific to compress safely, or not yet durable enough.
- Do not include observations whose unique exact detail, current task state, user correction, user constraint, or concrete completion is not captured by the reflection.
- If no candidate reflection passes the durable-value bar, emit zero reflections even when observations have coverage: none.
- Never invent observation ids. Proposals with missing, empty, or invalid supportingObservationIds are rejected.

User assertions are authoritative. If the observation pool contains both "User stated they use Postgres" and a later "User asked which db they are on", the assertion answers the question \u2014 crystallize the assertion, never the question, as the durable fact.

Reflection content rules:
- Single line of plain prose. No markdown, no bullets, no code fences, no XML/HTML tags, no emojis.
- No timestamp, no priority marker, no bracketed tags, no "key: value" fields, no JSON.
- Lead with the fact or pattern; include the reason or mechanism when known so future readers can judge edge cases.
- Preserve user assertions exactly. Use the user's exact words when non-standard.
- Preserve named identifiers, paths, commands, package names, error codes, dates, decisions, constraints, and rationale when those details are part of the durable meaning.

Examples:
- BAD: User discussed databases.
- GOOD: User stated they use Postgres for the project database.
- BAD: User asked about database setup.
- GOOD: User stated they use Postgres for the project database.
- BAD: User ran npm test and it failed.
- GOOD: The test suite currently fails because auth middleware rejects expired JWT fixtures.
- BAD: User prefers React Query.
- BAD: User switched from SWR.
- GOOD: User chose React Query over SWR for server-state caching.
- BAD: completed: edited src/hooks/reflect-drop-trigger.ts.
- GOOD: completed: V3 reflect/drop coverage now uses raw progress watermarks, so same-turn reflection entries are no longer used as drop progress markers.
- BAD: npm test passed.
- GOOD: completed: V3 package namespace migration passed full tests and typecheck.
- BAD: Observation aaaaaaaaaaaa says the user likes short answers.
- GOOD: User prefers short answers without generic summaries.
- ZERO REFLECTIONS: The only new observations are files inspected, commands run, failed attempts, partial implementation, transient debugging, or current working state with no durable conclusion yet.
- ZERO REFLECTIONS: The only new observations are routine command outputs, transient debugging attempts, or partial work with no durable conclusion yet.`;

// src/om/agents/reflector/agent.ts
var RecordReflectionsSchema = Type3.Object({
  reflections: Type3.Array(
    Type3.Object({
      content: Type3.String({ minLength: 1 }),
      supportingObservationIds: Type3.Array(Type3.String({ minLength: 1 }), { minItems: 1 })
    }),
    { minItems: 1 }
  )
});
function joinOrEmpty3(items) {
  return items.length ? items.join("\n") : "(none yet)";
}
function normalizeSupportingObservationIds(supportingObservationIds, allowedObservationIds) {
  if (!supportingObservationIds || supportingObservationIds.length === 0) return void 0;
  const allowedOrder = /* @__PURE__ */ new Map();
  for (let i = 0; i < allowedObservationIds.length; i++) {
    if (!allowedOrder.has(allowedObservationIds[i])) allowedOrder.set(allowedObservationIds[i], i);
  }
  const seen = /* @__PURE__ */ new Set();
  for (const id of supportingObservationIds) {
    if (!allowedOrder.has(id)) return void 0;
    seen.add(id);
  }
  if (seen.size === 0) return void 0;
  return Array.from(seen).sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}
function normalizeReflectionContent(content) {
  const normalized = truncateRecordContent(content.trim());
  if (!normalized || /\r|\n/.test(normalized)) return void 0;
  return normalized;
}
async function runReflector(args) {
  const { model, apiKey, headers, reflections, observations, signal } = args;
  const effectiveSystemPrompt = args.systemPrompt ?? REFLECTOR_SYSTEM;
  if (observations.length === 0) return void 0;
  const allowedObservationIds = observations.map((observation) => observation.id);
  const existingReflectionIds = new Set(reflections.map((reflection) => reflection.id));
  const accumulated = /* @__PURE__ */ new Map();
  const recordReflections = {
    name: "record_reflections",
    label: "Record reflections",
    description: "Record new durable reflections with supporting observation ids.",
    parameters: RecordReflectionsSchema,
    execute: async (_id, params) => {
      let added = 0;
      let duplicates = 0;
      let rejected = 0;
      for (const proposal of params.reflections) {
        const content = normalizeReflectionContent(proposal.content);
        const supportingObservationIds = normalizeSupportingObservationIds(proposal.supportingObservationIds, allowedObservationIds);
        if (!content || !supportingObservationIds) {
          rejected++;
          continue;
        }
        const id = hashId(content);
        if (existingReflectionIds.has(id) || accumulated.has(id)) {
          duplicates++;
          continue;
        }
        accumulated.set(id, {
          id,
          content,
          supportingObservationIds,
          tokenCount: estimateStringTokens(content)
        });
        added++;
      }
      return {
        content: [{ type: "text", text: `Recorded ${added} reflection${added === 1 ? "" : "s"}; ${duplicates} duplicate${duplicates === 1 ? "" : "s"}; ${rejected} rejected. Total this run: ${accumulated.size}.` }],
        details: { added, duplicates, rejected, total: accumulated.size }
      };
    }
  };
  const existingReflectionsContext = args.existingReflectionsSummary ? `EXISTING REFLECTIONS (for context only \u2014 do NOT re-process these):
${args.existingReflectionsSummary}

` : "";
  const existingObservationsContext = args.existingObservationsSummary ? `EXISTING OBSERVATIONS (for context only \u2014 do NOT re-process these):
${args.existingObservationsSummary}

` : "";
  const userText = `${existingReflectionsContext}${existingObservationsContext}NEW REFLECTIONS TO PROCESS:
${joinOrEmpty3(reflections.map(reflectionToSummaryLine))}

NEW OBSERVATIONS TO PROCESS:
${joinOrEmpty3(observations.map(observationToSummaryLine))}

Crystallize any missing durable facts or patterns into new reflections. If nothing is stable enough, do not call the tool.`;
  const promptCapture = {
    system: effectiveSystemPrompt,
    user: userText
  };
  const prompts = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
  const context = { systemPrompt: effectiveSystemPrompt, messages: [], tools: [recordReflections] };
  const reasoning = model.reasoning;
  const thinkingLevel = args.thinkingLevel ?? "low";
  const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : void 0;
  let turnCount = 0;
  const config = {
    model,
    apiKey,
    headers,
    maxTokens: boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS),
    convertToLlm: (msgs) => msgs,
    toolExecution: "sequential",
    ...reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {},
    ...effectiveMaxTurns !== void 0 ? { shouldStopAfterTurn: () => ++turnCount >= effectiveMaxTurns } : {}
  };
  const loop = args.agentLoop ?? agentLoop3;
  const bridgeStreamFn = createBridgeStreamFn(streamSimple3);
  const streamFn = args.streamFn ?? bridgeStreamFn;
  const stream = loop(prompts, context, config, signal, streamFn);
  let agentError;
  let transcript = [];
  for await (const event of stream) {
    if (event.type === "agent_end") {
      const msgs = event.messages || [];
      transcript = msgs.map(messageToTranscriptTurn);
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg?.stopReason === "error") {
        agentError = lastMsg.errorMessage ?? "Unknown API error";
      }
    }
  }
  await stream.result();
  if (agentError && accumulated.size === 0) throw new Error(`Reflector API error: ${agentError}`);
  if (accumulated.size === 0) return void 0;
  return { reflections: Array.from(accumulated.values()), prompt: promptCapture, transcript };
}

// src/replay.ts
var DEFAULT_THINKING_LEVEL = "low";
var DEFAULT_MAX_TURNS = 5;
var DEFAULT_OBSERVATION_POOL_BUDGET_TOKENS = 2e4;
var UNKNOWN_TIMESTAMP = "";
var UNKNOWN_SESSION_ID = "unknown-session";
var UNKNOWN_PROFILE = "unknown";
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function parseJsonl(content) {
  const entries = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line);
    if (isRecord(parsed)) entries.push(parsed);
  }
  return entries;
}
function entryType(entry) {
  return stringValue(entry.type);
}
function customType(entry) {
  return stringValue(entry.customType);
}
function entryId(entry) {
  return stringValue(entry.id);
}
function entryTimestamp(entry) {
  return stringValue(entry.timestamp) ?? UNKNOWN_TIMESTAMP;
}
function findSessionEntry(entries) {
  return entries.find((entry) => entryType(entry) === "session");
}
function sessionSlugFromPath(jsonlPath) {
  const file = basename(jsonlPath);
  const ext = extname(file);
  return ext ? file.slice(0, -ext.length) : file;
}
function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (!isRecord(block)) return "[non-text content omitted]";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "toolCall") {
        const name = typeof block.name === "string" ? block.name : "tool";
        return `[${name}(${JSON.stringify(block.arguments ?? {})})]`;
      }
      if (block.type === "thinking" && typeof block.thinking === "string") return `[thinking: ${block.thinking}]`;
      return "[non-text content omitted]";
    }).filter((part) => part.length > 0).join("\n");
  }
  return JSON.stringify(content);
}
function messageRole(entry) {
  const message = entry.message;
  if (!isRecord(message)) return "message";
  return stringValue(message.role) ?? "message";
}
function serializeMessageEntry(entry) {
  const message = entry.message;
  if (!isRecord(message)) return contentToText(entry.content);
  const role = messageRole(entry);
  if (role === "toolResult") {
    const toolName = stringValue(message.toolName) ?? "tool";
    return `toolResult ${toolName}: ${contentToText(message.content)}`;
  }
  return `${role}: ${contentToText(message.content)}`;
}
function serializeToolLikeEntry(entry) {
  const output = entry.output ?? entry.result ?? entry.content ?? entry.data;
  return `toolResult: ${contentToText(output)}`;
}
function isSourceEntry(entry) {
  const type = entryType(entry);
  if (type === "message") return true;
  return type === "tool_call" || type === "tool_result" || type === "toolCall" || type === "toolResult";
}
function serializeSourceEntries(entries) {
  const blocks = [];
  const sourceEntryIds = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const id = entryId(entry) ?? `source-${index + 1}`;
    const rendered = entryType(entry) === "message" ? serializeMessageEntry(entry) : serializeToolLikeEntry(entry);
    if (!rendered.trim()) continue;
    sourceEntryIds.push(id);
    blocks.push(`[Source entry id: ${id}]
${rendered}`);
  }
  return { chunk: blocks.join("\n\n"), sourceEntryIds };
}
function isObserverMarker(entry) {
  return entryType(entry) === "custom" && customType(entry) === "om.observations.recorded";
}
function isReflectorMarker(entry) {
  return entryType(entry) === "custom" && customType(entry) === "om.reflections.recorded";
}
function isDropperMarker(entry) {
  return entryType(entry) === "custom" && customType(entry) === "om.observations.dropped";
}
function isCompactionEntry(entry) {
  return entryType(entry) === "compaction";
}
function observationSummaryLine(observation) {
  return observationToSummaryLine(observation);
}
function reflectionSummaryLine(reflection) {
  return reflectionToSummaryLine(reflection);
}
function toObservationRecord(observation, runIndex) {
  return {
    id: observation.id,
    content: observation.content,
    kind: observation.kind ?? "objective",
    relevance: observation.relevance,
    timestamp: observation.timestamp,
    tokenCount: observation.tokenCount,
    sourceEntryIds: observation.sourceEntryIds,
    runIndex
  };
}
function toReflectionRecord(reflection, runIndex, timestamp) {
  return {
    id: reflection.id,
    content: reflection.content,
    timestamp,
    supportingObservationIds: reflection.supportingObservationIds,
    runIndex
  };
}
function observationRecordsAsLedger(observations) {
  return observations.map((observation) => ({
    id: observation.id,
    content: observation.content,
    timestamp: observation.timestamp,
    relevance: observation.relevance,
    sourceEntryIds: observation.sourceEntryIds,
    tokenCount: observation.tokenCount,
    kind: observation.kind
  }));
}
function reflectionRecordsAsLedger(reflections) {
  return reflections.map((reflection) => ({
    id: reflection.id,
    content: reflection.content,
    supportingObservationIds: reflection.supportingObservationIds,
    tokenCount: Math.ceil(reflection.content.length / 4)
  }));
}
function reflectedObservationIds(reflections) {
  const ids = /* @__PURE__ */ new Set();
  for (const reflection of reflections) {
    for (const observationId of reflection.supportingObservationIds) ids.add(observationId);
  }
  return ids;
}
function promptFromObserverResult(result) {
  return result.prompt;
}
function promptFromReflectorResult(result) {
  return result?.prompt ?? { system: "", user: "" };
}
function promptFromDropperResult(result) {
  return result?.prompt ?? { system: "", user: "" };
}
function startEpoch(index) {
  return { label: `epoch-${index}`, stages: [] };
}
function foldAtCompaction(state) {
  state.sourceEntries = [];
}
function resolveReplayModel(modelRef) {
  const resolved = getModel(modelRef.provider, modelRef.id);
  if (resolved) return resolved;
  const api = modelRef.api ?? modelRef.provider;
  return {
    provider: modelRef.provider,
    id: modelRef.id,
    name: modelRef.id,
    api,
    baseUrl: modelRef.baseUrl ?? "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128e3,
    maxTokens: 32e3
  };
}
function addObservations(state, observations) {
  state.allObservations.push(...observations);
  state.activeObservations.push(...observations);
}
function addReflections(state, reflections) {
  state.allReflections.push(...reflections);
  state.activeReflections.push(...reflections);
}
function dropObservations(state, droppedIds) {
  for (const id of droppedIds) state.droppedObservationIds.add(id);
  const dropped = new Set(droppedIds);
  state.activeObservations = state.activeObservations.filter((observation) => !dropped.has(observation.id));
}
async function replaySession(args) {
  const text = await readFile(args.jsonlPath, "utf8");
  const entries = parseJsonl(text);
  const sessionEntry = findSessionEntry(entries);
  const sessionId = stringValue(sessionEntry?.id) ?? UNKNOWN_SESSION_ID;
  const sessionSlug = stringValue(sessionEntry?.slug) ?? stringValue(sessionEntry?.sessionSlug) ?? sessionSlugFromPath(args.jsonlPath);
  const profile = stringValue(sessionEntry?.profile) ?? UNKNOWN_PROFILE;
  const thinkingLevel = args.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
  const maxTurns = args.maxTurns ?? DEFAULT_MAX_TURNS;
  const model = resolveReplayModel(args.model);
  const modelInfo = { provider: model.provider, id: model.id };
  const state = {
    sourceEntries: [],
    activeObservations: [],
    activeReflections: [],
    allObservations: [],
    allReflections: [],
    droppedObservationIds: /* @__PURE__ */ new Set(),
    foldedObservationIds: /* @__PURE__ */ new Set(),
    foldedReflectionIds: /* @__PURE__ */ new Set(),
    runIndex: { observer: 0, reflector: 0, dropper: 0 }
  };
  const epochs = [];
  let currentEpoch = startEpoch(1);
  for (const entry of entries) {
    if (entryType(entry) === "session") continue;
    if (isSourceEntry(entry)) {
      state.sourceEntries.push(entry);
      continue;
    }
    if (isObserverMarker(entry)) {
      const { chunk, sourceEntryIds } = serializeSourceEntries(state.sourceEntries);
      state.runIndex.observer++;
      const result = await runObserver({
        model,
        apiKey: args.apiKey,
        headers: args.headers,
        priorReflections: state.activeReflections.map(reflectionSummaryLine),
        priorObservations: state.activeObservations.map(observationSummaryLine),
        chunk,
        allowedSourceEntryIds: sourceEntryIds,
        thinkingLevel,
        maxTurns,
        ...args.promptOverrides?.observer !== void 0 ? { systemPrompt: args.promptOverrides.observer } : {}
      });
      const newObservations = (result.observations ?? []).map(
        (observation) => toObservationRecord(observation, state.runIndex.observer)
      );
      addObservations(state, newObservations);
      currentEpoch.stages.push({
        type: "observer",
        timestamp: entryTimestamp(entry),
        model: modelInfo,
        chunkEntryCount: state.sourceEntries.length,
        newObservations,
        promptUsed: promptFromObserverResult(result)
      });
      state.sourceEntries = [];
      continue;
    }
    if (isReflectorMarker(entry)) {
      const alreadyReflected = reflectedObservationIds(state.activeReflections);
      const unreflectedObservations = state.activeObservations.filter((observation) => !alreadyReflected.has(observation.id));
      state.runIndex.reflector++;
      const result = await runReflector({
        model,
        apiKey: args.apiKey,
        headers: args.headers,
        reflections: [],
        observations: observationRecordsAsLedger(unreflectedObservations),
        existingReflectionsSummary: state.activeReflections.map(reflectionSummaryLine).join("\n") || void 0,
        thinkingLevel,
        maxTurns,
        ...args.promptOverrides?.reflector !== void 0 ? { systemPrompt: args.promptOverrides.reflector } : {}
      });
      const newReflections = (result?.reflections ?? []).map(
        (reflection) => toReflectionRecord(reflection, state.runIndex.reflector, entryTimestamp(entry))
      );
      addReflections(state, newReflections);
      currentEpoch.stages.push({
        type: "reflector",
        timestamp: entryTimestamp(entry),
        model: modelInfo,
        newReflections,
        promptUsed: promptFromReflectorResult(result)
      });
      continue;
    }
    if (isDropperMarker(entry)) {
      state.runIndex.dropper++;
      const result = await runDropper({
        model,
        apiKey: args.apiKey,
        headers: args.headers,
        reflections: reflectionRecordsAsLedger(state.activeReflections),
        observations: observationRecordsAsLedger(state.activeObservations),
        budgetTokens: DEFAULT_OBSERVATION_POOL_BUDGET_TOKENS,
        thinkingLevel,
        maxTurns,
        ...args.promptOverrides?.dropper !== void 0 ? { systemPrompt: args.promptOverrides.dropper } : {}
      });
      const droppedIds = result?.dropIds ?? [];
      dropObservations(state, droppedIds);
      currentEpoch.stages.push({
        type: "dropper",
        timestamp: entryTimestamp(entry),
        model: modelInfo,
        droppedIds,
        dropReasons: result?.dropReasons ?? {},
        promptUsed: promptFromDropperResult(result)
      });
      continue;
    }
    if (isCompactionEntry(entry)) {
      currentEpoch.compactionId = entryId(entry);
      foldAtCompaction(state);
      epochs.push(currentEpoch);
      currentEpoch = startEpoch(epochs.length + 1);
    }
  }
  if (currentEpoch.stages.length > 0 || epochs.length === 0) epochs.push(currentEpoch);
  return {
    sessionId,
    sessionSlug,
    profile,
    epochs,
    allObservations: state.allObservations,
    allReflections: state.allReflections,
    survivingObservations: state.allObservations.filter(
      (observation) => !state.droppedObservationIds.has(observation.id) && !state.foldedObservationIds.has(observation.id)
    ),
    survivingReflections: state.allReflections.filter((reflection) => !state.foldedReflectionIds.has(reflection.id))
  };
}

// src/replay_cli.ts
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function main() {
  const input = await readStdin();
  if (!input.trim()) {
    console.error("usage: echo '<replay-args-json>' | node replay_bundle.mjs");
    process.exit(1);
  }
  const args = JSON.parse(input);
  const result = await replaySession(args);
  process.stdout.write(JSON.stringify(result));
}
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("replay error:", message);
  process.exit(1);
});
