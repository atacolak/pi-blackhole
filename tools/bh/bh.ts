#!/usr/bin/env npx tsx
/**
 * bh — blackhole session forensics CLI.
 *
 * Correlates pi session JSONL files with their
 * observation/reflection/dropper artifacts from the pi-blackhole pipeline.
 *
 * Usage:
 *   bh overview    <session>      One-shot session + pipeline summary
 *   bh trace       <session>      Observation/reflection lifecycle across passes
 *   bh passes      <session>      Pass-by-pass stats table
 *   bh pipeline    <session>      Stage timing visualization
 *   bh drift       <session>      What was dropped and why
 *   bh snapshot    <session> <n>  Deep-dive one pass: prompts, outputs, decisions
 *   bh gaps        <session>      Anomalies, compactions, model changes, prompt overrides
 *   bh provenance  <session>      Prompt versions, hashes, and overrides per stage run
 *   bh epochs      <session>      Compaction-bounded memory epochs with OM binning
 *   bh render      <session>      Export to Obsidian vault markdown
 */

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SessionEntry {
  id?: string;
  type: string;
  [key: string]: unknown;
}

interface StageArtifact {
  stage: "observer" | "reflector" | "dropper";
  timestamp: string;
  model: { provider: string; id: string };
  prompt_id?: string;
  prompt_hash?: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  durationMs?: number;
}

interface Pass {
  index: number;
  observer?: StageArtifact;
  reflector?: StageArtifact;
  dropper?: StageArtifact;
}

interface FoldedOM {
  type?: string;
  version?: number;
  fullFold?: boolean;
  observations?: Array<{
    id: string;
    content: string;
    relevance: string;
    timestamp?: string;
    tokenCount?: number;
  }>;
  reflections?: Array<{
    id: string;
    content: string;
    supportingObservationIds?: string[];
  }>;
}

interface CompactionEntry extends SessionEntry {
  details?: {
    compactor?: string;
    version?: number;
    sections?: string[];
    sourceMessageCount?: number;
    previousSummaryUsed?: boolean;
    "om.folded"?: FoldedOM;
  };
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
}

// ─── Resolution ──────────────────────────────────────────────────────────────

const HOME = process.env.HOME || "/home/sf";

function findSession(spec: string): { path: string; id: string } {
  // Direct file path
  if (existsSync(spec) && statSync(spec).isFile()) {
    const content = readFileSync(spec, "utf-8");
    const firstLine = content.split("\n")[0];
    let id = "";
    try {
      const parsed = JSON.parse(firstLine) as SessionEntry;
      if (parsed.id) id = parsed.id;
    } catch { /* fall through */ }
    if (!id) {
      const match = basename(spec).match(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
      );
      if (match) id = match[1];
    }
    return { path: spec, id };
  }

  // UUID — search known session directories
  const uuidMatch = spec.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  const searchId = uuidMatch ? uuidMatch[1] : spec;

  const searchDirs = [
    join(HOME, ".pi", "profiles"),
    join(HOME, "workspace", ".pi", "profiles"),
    join(HOME, ".pi", "sessions"),
    join(HOME, "workspace", ".pi", "sessions"),
  ];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    const result = findSessionFile(dir, searchId);
    if (result) return result;
  }

  console.error(`session not found: ${spec}`);
  process.exit(1);
}

function findSessionFile(
  root: string,
  searchId: string
): { path: string; id: string } | null {
  try {
    const entries = readdirSync(root, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      if (!entry.name.includes(searchId)) continue;
      const fullPath = join(entry.parentPath ?? entry.path ?? root, entry.name);
      try {
        const firstLine = readFileSync(fullPath, "utf-8").split("\n")[0];
        const parsed = JSON.parse(firstLine) as SessionEntry;
        if (parsed.id === searchId || parsed.id?.includes(searchId)) {
          return { path: fullPath, id: parsed.id || searchId };
        }
      } catch {
        /* try next */
      }
    }
  } catch {
    /* skip unreadable */
  }

  // fallback: filename match only
  try {
    const entries = readdirSync(root, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      if (entry.name.includes(searchId)) {
        const fullPath = join(
          entry.parentPath ?? entry.path ?? root,
          entry.name
        );
        return { path: fullPath, id: searchId };
      }
    }
  } catch {
    /* skip */
  }

  return null;
}

function findBlackholeArtifacts(sessionId: string): StageArtifact[] {
  const candidates = [
    join(HOME, ".pi", "blackhole", "runs", sessionId),
    join(HOME, "workspace", ".pi", "blackhole", "runs", sessionId),
  ];

  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
      return files.map((f) => {
        const content = readFileSync(join(dir, f), "utf-8");
        return JSON.parse(content) as StageArtifact;
      });
    } catch {
      continue;
    }
  }
  return [];
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

function loadSessionEntries(path: string): SessionEntry[] {
  const content = readFileSync(path, "utf-8");
  return content
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SessionEntry);
}

function groupPasses(artifacts: StageArtifact[]): Pass[] {
  const passes: Pass[] = [];
  let current: Pass = { index: 0 };

  for (const a of artifacts) {
    if (a.stage === "observer") {
      if (current.observer) {
        passes.push(current);
        current = { index: passes.length + 1, observer: a };
      } else {
        current.observer = a;
        current.index = passes.length + 1;
      }
    } else if (a.stage === "reflector") {
      current.reflector = a;
    } else if (a.stage === "dropper") {
      current.dropper = a;
      passes.push(current);
      current = { index: passes.length + 1 };
    }
  }
  if (current.observer || current.reflector || current.dropper) {
    passes.push(current);
  }
  return passes;
}

// ─── Custom entry extraction ─────────────────────────────────────────────────

function extractObsRecorded(
  entries: SessionEntry[]
): Array<{ observations?: Array<Record<string, unknown>> }> {
  return entries
    .filter(
      (e) =>
        e.type === "custom" && (e as any).customType === "om.observations.recorded"
    )
    .map((e) => ((e as any).data ?? {}) as any);
}

function extractReflRecorded(
  entries: SessionEntry[]
): Array<{ reflections?: Array<Record<string, unknown>> }> {
  return entries
    .filter(
      (e) =>
        e.type === "custom" && (e as any).customType === "om.reflections.recorded"
    )
    .map((e) => ((e as any).data ?? {}) as any);
}

function extractObsDropped(
  entries: SessionEntry[]
): Array<{ observationIds?: string[] }> {
  return entries
    .filter(
      (e) =>
        e.type === "custom" && (e as any).customType === "om.observations.dropped"
    )
    .map((e) => ((e as any).data ?? {}) as any);
}

/** Extract dropped IDs from artifact dropper outputs. */
function extractArtifactDropIds(passes: Pass[]): string[] {
  const ids = new Set<string>();
  for (const p of passes) {
    const out = p.dropper?.output as any;
    if (!out?.droppedIds) continue;
    for (const id of out.droppedIds) ids.add(id);
  }
  return [...ids];
}

/** Extract folded observations from compaction entry's details.om.folded. */
function extractFoldedObservations(
  entries: SessionEntry[]
): { count: number; observations: FoldedOM["observations"] } {
  for (const e of entries) {
    if (e.type !== "compaction") continue;
    const ce = e as CompactionEntry;
    const folded = ce.details?.["om.folded"];
    if (!folded) continue;
    return {
      count: folded.observations?.length ?? 0,
      observations: folded.observations ?? [],
    };
  }
  return { count: 0, observations: [] };
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function dim(s: string): string {
  return `${DIM}${s}${RESET}`;
}
function bold(s: string): string {
  return `${BOLD}${s}${RESET}`;
}
function green(s: string): string {
  return `${GREEN}${s}${RESET}`;
}
function yellow(s: string): string {
  return `${YELLOW}${s}${RESET}`;
}
function red(s: string): string {
  return `${RED}${s}${RESET}`;
}
function cyan(s: string): string {
  return `${CYAN}${s}${RESET}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtDur(ms?: number): string {
  if (ms === undefined) return "";
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(n?: number): string {
  if (n === undefined) return "";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function pad(s: string, n: number): string {
  return s.padEnd(n);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

// ─── Commands ────────────────────────────────────────────────────────────────

function cmdOverview(spec: string) {
  const { path: sesPath, id: sesId } = findSession(spec);
  const entries = loadSessionEntries(sesPath);
  const artifacts = findBlackholeArtifacts(sesId);
  const passes = groupPasses(artifacts);

  const header = entries[0] as SessionEntry & {
    timestamp?: string;
    cwd?: string;
  };
  const byType: Record<string, number> = {};
  for (const e of entries) {
    byType[e.type] = (byType[e.type] || 0) + 1;
  }

  const obsRecorded = extractObsRecorded(entries);
  const reflRecorded = extractReflRecorded(entries);
  const obsDropped = extractObsDropped(entries);
  const artifactDropIds = extractArtifactDropIds(passes);

  const totalObs = obsRecorded.reduce(
    (s, o) => s + (o.observations?.length ?? 0),
    0
  );
  const totalRefl = reflRecorded.reduce(
    (s, r) => s + (r.reflections?.length ?? 0),
    0
  );
  const totalDropEvents = Math.max(
    obsDropped.reduce((s, d) => s + (d.observationIds?.length ?? 0), 0),
    artifactDropIds.length
  );
  const uniqueDropped = [...new Set([
    ...obsDropped.flatMap(d => d.observationIds ?? []),
    ...artifactDropIds,
  ])].length;

  const profileMatch = sesPath.match(/profiles\/([^/]+)\/sessions/);
  const profile = profileMatch ? profileMatch[1] : "?";

  const folded = extractFoldedObservations(entries);

  console.log(`\n${bold("bh overview")}  ${dim(sesId)}`);
  console.log(`${dim("\u2500".repeat(60))}`);
  console.log(`${pad("session file:", 20)} ${sesPath}`);
  console.log(`${pad("profile:", 20)} ${profile}`);
  console.log(`${pad("start:", 20)} ${header.timestamp ?? "?"}`);
  console.log(`${pad("cwd:", 20)} ${(header as any).cwd ?? "?"}`);
  console.log(`${pad("entries:", 20)} ${entries.length} total`);
  for (const [t, c] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(t, 30)} ${c}`);
  }

  console.log(`\n${bold("blackhole pipeline")}`);
  console.log(`${pad("passes:", 20)} ${passes.length}`);
  console.log(`${pad("artifacts:", 20)} ${artifacts.length}`);
  console.log(`${pad("observations recorded:", 20)} ${totalObs}`);
  console.log(`${pad("reflections recorded:", 20)} ${totalRefl}`);
  console.log(`${pad("observations dropped:", 20)} ${totalDropEvents} events, ${uniqueDropped} unique`);
  console.log(`${pad("folded at compaction:", 20)} ${folded.count} observations`);

  if (passes.length > 0) {
    const last = passes[passes.length - 1];
    const pool = last.dropper?.input as any;
    if (pool) {
      console.log(`${pad("final pool tokens:", 20)} ${fmtTokens(pool.poolTokens)}`);
      console.log(`${pad("final budget tokens:", 20)} ${fmtTokens(pool.budgetTokens)}`);
      console.log(`${pad("final fullness:", 20)} ${Math.round((pool.fullness ?? 0) * 100)}%`);
    }
  }

  const artifactsWithDur = artifacts.filter((a) => a.durationMs !== undefined);
  if (artifactsWithDur.length > 0) {
    const totalDur = artifactsWithDur.reduce((s, a) => s + a.durationMs!, 0);
    console.log(`${pad("total pipeline time:", 20)} ${fmtDur(totalDur)}`);
  } else {
    console.log(`${pad("pipeline timing:", 20)} ${dim("(not recorded in artifacts)")}`);
  }
  console.log();
}

function cmdTrace(spec: string) {
  const { path: sesPath, id: sesId } = findSession(spec);
  const entries = loadSessionEntries(sesPath);
  const artifacts = findBlackholeArtifacts(sesId);
  const passes = groupPasses(artifacts);

  const allObs: Map<
    string,
    {
      content: string;
      relevance: string;
      passCreated: number;
      passDropped?: number;
    }
  > = new Map();
  const allRefls: Map<
    string,
    { content: string; passCreated: number; supportingObs: string[] }
  > = new Map();

  console.log(
    `\n${bold("bh trace")}  ${dim(sesId)} \u2014 observation/reflection lifecycle\n`
  );

  for (let i = 0; i < passes.length; i++) {
    const p = passes[i];
    const obsArt = p.observer?.output as any;
    const reflArt = p.reflector?.output as any;
    const dropArt = p.dropper?.output as any;

    const artifactObs = obsArt?.observations ?? [];
    for (const o of artifactObs) {
      allObs.set(o.id, {
        content: o.content,
        relevance: o.relevance,
        timestamp: o.timestamp,
        passCreated: i,
      });
    }

    const artifactRefls = reflArt?.reflections ?? [];
    for (const r of artifactRefls) {
      allRefls.set(r.id, {
        content: r.content,
        passCreated: i,
        supportingObs: r.supportingObservationIds ?? [],
      });
    }

    const droppedIds: string[] = dropArt?.droppedIds ?? [];
    for (const did of droppedIds) {
      const existing = allObs.get(did);
      if (existing) existing.passDropped = i;
    }

    const obsCount = artifactObs.length;
    const reflCount = artifactRefls.length;
    const dropCount = droppedIds.length;

    const obsLabel =
      obsCount > 0 ? `${green(`+${obsCount} obs`)}` : dim("\u00b7");
    const reflLabel =
      reflCount > 0 ? `${cyan(`+${reflCount} refl`)}` : dim("\u00b7");
    const dropLabel =
      dropCount > 0 ? `${red(`-${dropCount} drop`)}` : dim("\u00b7");

    const poolAfter = p.dropper?.input as any;
    const poolInfo = poolAfter
      ? `  pool:${fmtTokens(poolAfter.poolTokens)}/${fmtTokens(poolAfter.budgetTokens)} ${Math.round((poolAfter.fullness ?? 0) * 100)}%`
      : "";

    const keyObs = artifactObs.filter(
      (o: any) => o.relevance === "high" || o.relevance === "critical"
    );
    const obsPreview = keyObs.length
      ? keyObs
          .slice(0, 2)
          .map(
            (o: any) =>
              `  ${DIM}\u2514 obs ${o.id.slice(0, 8)} [${o.relevance}] ${truncate(o.content, 80)}${RESET}`
          )
          .join("\n")
      : "";

    console.log(
      `${bold(`pass ${i + 1}`)}  ${fmtTime(p.observer?.timestamp ?? p.timestamp)}  ${obsLabel} ${reflLabel} ${dropLabel}${poolInfo}`
    );
    if (obsPreview) console.log(obsPreview);
  }

  // Merge session drops (may reference ids not in artifact catalog)
  const obsDropped = extractObsDropped(entries);
  const sessionDropIds = new Set<string>();
  for (const d of obsDropped) {
    for (const did of d.observationIds ?? []) sessionDropIds.add(did);
  }
  for (const did of sessionDropIds) {
    const existing = allObs.get(did);
    if (existing && existing.passDropped === undefined) {
      existing.passDropped = -1; // session drop, not matched to artifact pass
    }
  }

  const alive = [...allObs.values()].filter((o) => o.passDropped === undefined);
  const droppedArr = [...allObs.values()].filter(
    (o) => o.passDropped !== undefined
  );
  console.log(`\n${bold("summary")}`);
  console.log(`  observations created: ${allObs.size}`);
  console.log(`  still alive:          ${green(String(alive.length))}`);
  console.log(`  dropped:              ${red(String(droppedArr.length))}`);
  console.log(`  reflections created:  ${allRefls.size}`);
  console.log();
}

function cmdPasses(spec: string) {
  const { path: sesPath, id: sesId } = findSession(spec);
  const artifacts = findBlackholeArtifacts(sesId);
  const passes = groupPasses(artifacts);

  console.log(`\n${bold("bh passes")}  ${dim(sesId)}\n`);
  console.log(
    ` ${pad("#", 4)} ${pad("time", 10)} ${pad("observer", 10)} ${pad("reflector", 10)} ${pad("dropper", 10)} ${pad("obs", 6)} ${pad("new refl", 9)} ${pad("dropped", 8)} ${pad("pool", 10)}`
  );
  console.log(dim("\u2500".repeat(90)));

  for (let i = 0; i < passes.length; i++) {
    const p = passes[i];
    const t = fmtTime(
      p.observer?.timestamp ?? p.reflector?.timestamp ?? p.dropper?.timestamp ?? "?"
    );
    const oDur = p.observer?.durationMs !== undefined ? fmtDur(p.observer.durationMs) : dim("-");
    const rDur = p.reflector?.durationMs !== undefined ? fmtDur(p.reflector.durationMs) : dim("-");
    const dDur = p.dropper?.durationMs !== undefined ? fmtDur(p.dropper.durationMs) : dim("-");

    const obsCount =
      (p.observer?.output as any)?.observations?.length ?? 0;
    const reflCount =
      (p.reflector?.output as any)?.reflections?.length ?? 0;
    const dropCount = (p.dropper?.output as any)?.droppedIds?.length ?? 0;

    const poolAfter = p.dropper?.input as any;
    const poolStr = poolAfter
      ? `${fmtTokens(poolAfter.poolTokens)}/${fmtTokens(poolAfter.budgetTokens)} ${Math.round((poolAfter.fullness ?? 0) * 100)}%`
      : dim("-");

    const obsStr = obsCount > 0 ? green(String(obsCount)) : dim("0");
    const reflStr = reflCount > 0 ? cyan(String(reflCount)) : dim("0");
    const dropStr = dropCount > 0 ? red(String(dropCount)) : dim("0");

    console.log(
      ` ${pad(String(i + 1), 4)} ${pad(t, 10)} ${pad(oDur, 10)} ${pad(rDur, 10)} ${pad(dDur, 10)} ${pad(obsStr, 6)} ${pad(reflStr, 9)} ${pad(dropStr, 8)} ${poolStr}`
    );
  }
  console.log();
}

function cmdPipeline(spec: string) {
  const { path: sesPath, id: sesId } = findSession(spec);
  const artifacts = findBlackholeArtifacts(sesId);
  const passes = groupPasses(artifacts);

  console.log(
    `\n${bold("bh pipeline")}  ${dim(sesId)} \u2014 stage timing per pass\n`
  );

  const rows: {
    pass: number;
    stage: string;
    dur: number;
    hasDur: boolean;
    model: string;
    detail: string;
  }[] = [];

  let anyDuration = false;
  for (let i = 0; i < passes.length; i++) {
    const p = passes[i];
    for (const stage of ["observer", "reflector", "dropper"] as const) {
      const a = p[stage];
      if (!a) continue;
      let detail = "";
      const out = a.output as any;
      if (stage === "observer") detail = `${out?.observationCount ?? out?.observations?.length ?? 0} obs`;
      else if (stage === "reflector")
        detail = `${out?.reflectionCount ?? out?.reflections?.length ?? 0} refl`;
      else if (stage === "dropper")
        detail = `${out?.droppedCount ?? out?.droppedIds?.length ?? 0} dropped`;
      const hasDur = a.durationMs !== undefined;
      if (hasDur) anyDuration = true;
      rows.push({
        pass: i + 1,
        stage: stage[0].toUpperCase() + stage.slice(1),
        dur: a.durationMs ?? 0,
        hasDur,
        model: a.model.id,
        detail,
      });
    }
  }

  if (!anyDuration) {
    // No timing data available — show compact table without bar chart
    console.log(` ${pad("pass", 5)} ${pad("stage", 12)} ${pad("detail", 25)} model`);
    console.log(dim("\u2500".repeat(60)));
    for (const r of rows) {
      const stageLabel =
        r.stage === "Observer"
          ? green("observer")
          : r.stage === "Reflector"
            ? cyan("reflector")
            : yellow("dropper");
      console.log(
        ` ${pad(String(r.pass), 5)} ${pad(stageLabel, 12)} ${pad(r.detail, 25)} ${dim(r.model)}`
      );
    }
    console.log(`\n  ${dim("(no duration data in artifacts)")}`);
    console.log();
    return;
  }

  const maxDur = Math.max(...rows.map((r) => r.dur), 1);
  const barW = 40;

  console.log(
    ` ${pad("pass", 5)} ${pad("stage", 12)} ${pad("dur", 8)} ${pad("bar", barW + 2)} ${pad("detail", 20)} model`
  );
  console.log(dim("\u2500".repeat(100)));

  for (const r of rows) {
    const barLen = Math.max(1, Math.round((r.dur / maxDur) * barW));
    const bar = "\u2588".repeat(Math.min(barLen, barW));
    const durStr = r.dur >= 1000 ? `${(r.dur / 1000).toFixed(1)}s` : `${r.dur}ms`;
    const stageLabel =
      r.stage === "Observer"
        ? green("observer")
        : r.stage === "Reflector"
          ? cyan("reflector")
          : yellow("dropper");
    console.log(
      ` ${pad(String(r.pass), 5)} ${pad(stageLabel, 12)} ${pad(durStr, 8)} ${bar}${DIM}${pad("", Math.max(0, barW - barLen))}${RESET}  ${pad(r.detail, 20)} ${dim(r.model)}`
    );
  }

  const totalDur = rows.reduce((s, r) => s + r.dur, 0);
  console.log(
    `\n  total pipeline wall time: ${fmtDur(totalDur)} (sequential \u2014 stages don't overlap)`
  );
  console.log();
}

function cmdDrift(spec: string) {
  const { path: sesPath, id: sesId } = findSession(spec);
  const entries = loadSessionEntries(sesPath);
  const artifacts = findBlackholeArtifacts(sesId);
  const passes = groupPasses(artifacts);

  const obsDropped = extractObsDropped(entries);
  const artifactDrops = extractArtifactDropIds(passes);

  // Build observation catalog from artifacts
  const allObs: Map<
    string,
    { content: string; relevance: string; passCreated: number }
  > = new Map();
  for (let i = 0; i < passes.length; i++) {
    const obsArt = passes[i].observer?.output as any;
    if (!obsArt?.observations) continue;
    for (const o of obsArt.observations) {
      if (!allObs.has(o.id)) {
        allObs.set(o.id, {
          content: o.content,
          relevance: o.relevance,
          passCreated: i,
        });
      }
    }
  }

  const sessionDrops = new Set<string>();
  for (const d of obsDropped) {
    for (const did of d.observationIds ?? []) sessionDrops.add(did);
  }
  for (const did of artifactDrops) sessionDrops.add(did);

  const dropped = [...sessionDrops];
  if (dropped.length === 0) {
    console.log(
      `\n${bold("bh drift")}  ${dim(sesId)} \u2014 no observations were dropped in this session\n`
    );
    return;
  }

  console.log(
    `\n${bold("bh drift")}  ${dim(sesId)} \u2014 ${dropped.length} observations dropped\n`
  );

  for (const did of dropped) {
    const obs = allObs.get(did);
    if (!obs) {
      console.log(`  ${dim(did.slice(0, 12))}  (not found in artifact catalog)`);
      continue;
    }
    const label =
      obs.relevance === "high" || obs.relevance === "critical"
        ? yellow(`[${obs.relevance}]`)
        : dim(`[${obs.relevance}]`);
    console.log(
      `  ${red("\u2717")} ${dim(did.slice(0, 12))} ${label}  ${truncate(obs.content, 100)}`
    );
  }
  console.log();
}

function cmdSnapshot(spec: string, passN: number) {
  const { path: sesPath, id: sesId } = findSession(spec);
  const artifacts = findBlackholeArtifacts(sesId);
  const passes = groupPasses(artifacts);

  if (passN < 1 || passN > passes.length) {
    console.error(`pass ${passN} out of range (1-${passes.length})`);
    process.exit(1);
  }

  const p = passes[passN - 1];
  console.log(`\n${bold(`bh snapshot pass ${passN}`)}  ${dim(sesId)}\n`);

  if (p.observer) {
    const o = p.observer;
    const provInfo = [];
    if (o.prompt_id) provInfo.push(cyan(`v=${o.prompt_id}`));
    if (o.input.prompt_override) provInfo.push(yellow("override"));
    const provStr = provInfo.length > 0 ? `  ${provInfo.join(" ")}` : "";
    console.log(
      `${bold("observer")}   ${dim(o.timestamp)}  ${dim(o.model.provider + "/" + o.model.id)}  ${fmtDur(o.durationMs)}${provStr}`
    );
    const obsOut = o.output as any;
    if (obsOut?.observations?.length) {
      for (const obs of obsOut.observations) {
        const label =
          obs.relevance === "high" || obs.relevance === "critical"
            ? yellow(`[${obs.relevance}]`)
            : dim(`[${obs.relevance}]`);
        console.log(`  ${green("+")} ${dim(obs.id.slice(0, 12))} ${label}  ${obs.content}`);
      }
    } else if (obsOut?.emptyReason) {
      console.log(`  ${dim("empty:")} ${obsOut.emptyReason}`);
    } else {
      console.log(`  ${dim("0 observations")}`);
    }
  }

  if (p.reflector) {
    const r = p.reflector;
    const rProvInfo = [];
    if (r.prompt_id) rProvInfo.push(cyan(`v=${r.prompt_id}`));
    if (r.input.prompt_override) rProvInfo.push(yellow("override"));
    const rProvStr = rProvInfo.length > 0 ? `  ${rProvInfo.join(" ")}` : "";
    console.log(
      `\n${bold("reflector")} ${dim(r.timestamp)}  ${dim(r.model.provider + "/" + r.model.id)}  ${fmtDur(r.durationMs)}${rProvStr}`
    );
    const reflOut = r.output as any;
    if (reflOut?.reflections?.length) {
      for (const refl of reflOut.reflections) {
        console.log(`  ${cyan("\u25c6")} ${dim(refl.id.slice(0, 12))}  ${refl.content}`);
        if (refl.supportingObservationIds?.length) {
          console.log(
            `    ${dim("supports:")} ${refl.supportingObservationIds.map((sid: string) => sid.slice(0, 8)).join(", ")}`
          );
        }
      }
    } else {
      console.log(`  ${dim("0 reflections")}`);
    }
  }

  if (p.dropper) {
    const d = p.dropper;
    const dProvInfo = [];
    if (d.prompt_id) dProvInfo.push(cyan(`v=${d.prompt_id}`));
    if (d.input.prompt_override) dProvInfo.push(yellow("override"));
    const dProvStr = dProvInfo.length > 0 ? `  ${dProvInfo.join(" ")}` : "";
    console.log(
      `\n${bold("dropper")}   ${dim(d.timestamp)}  ${dim(d.model.provider + "/" + d.model.id)}  ${fmtDur(d.durationMs)}${dProvStr}`
    );
    const dropOut = d.output as any;
    const dropIn = d.input as any;
    console.log(
      `  ${pad("pool:", 14)} ${fmtTokens(dropIn.poolTokens)} / ${fmtTokens(dropIn.budgetTokens)} tok  (${Math.round((dropIn.fullness ?? 0) * 100)}% full)`
    );
    console.log(`  ${pad("urgency:", 14)} ${dropIn.urgency}`);
    console.log(`  ${pad("dropped:", 14)} ${red(String(dropOut.droppedCount))} observations`);
    if (dropOut.droppedIds?.length) {
      for (const did of dropOut.droppedIds) {
        console.log(`    ${red("\u2717")} ${dim(did.slice(0, 12))}`);
      }
    }
    console.log(`  ${pad("kept:", 14)} ${green(String(dropOut.keptCount))} observations`);
  }
  console.log();
}

function cmdGaps(spec: string) {
  const { path: sesPath, id: sesId } = findSession(spec);
  const entries = loadSessionEntries(sesPath);

  console.log(`\n${bold("bh gaps")}  ${dim(sesId)} \u2014 anomalies & notes\n`);

  // 1. Tool calls used (from assistant message content blocks)
  const toolNames = new Set<string>();
  for (const e of entries) {
    if (e.type !== "message") continue;
    const msg = (e as any).message;
    if (msg?.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "toolCall" && block.name) {
        toolNames.add(block.name);
      }
    }
  }
  console.log(`${bold("tool calls used:")} ${[...toolNames].join(", ")}`);
  const roleCounts: Record<string, number> = {};
  for (const e of entries) {
    if (e.type !== "message") continue;
    const role = (e as any).message?.role ?? "?";
    roleCounts[role] = (roleCounts[role] || 0) + 1;
  }
  console.log(
    `  message roles: ${Object.entries(roleCounts).map(([r, c]) => `${r}=${c}`).join(", ")}`
  );

  // 2. Compaction events
  const compactions = entries.filter(
    (e) => e.type === "compaction" || e.type === "om.folded"
  );
  for (const c of compactions) {
    if (c.type === "om.folded") {
      // standalone om.folded entry
      console.log(`  ${yellow("\u2139")} om.folded entry (standalone)`);
    } else {
      const ce = c as CompactionEntry;
      const firstKept = ce.firstKeptEntryId ?? "?";
      const summaryLen = (ce.summary?.length ?? 0).toString();
      const tokensBefore = ce.tokensBefore
        ? `${fmtTokens(ce.tokensBefore)} tok`
        : "";
      console.log(
        `  ${dim("\u25c6")} compaction  firstKept:${firstKept}  summary:${summaryLen}ch  ${tokensBefore}`
      );
    }
  }

  // 3. Model changes
  const modelChanges = entries.filter((e) => e.type === "model_change");
  for (const m of modelChanges) {
    console.log(
      `  ${dim("\u25c7")} model change: ${JSON.stringify((m as any).data ?? m)}`
    );
  }

  // 3b. Prompt overrides (from pipeline artifacts)
  const artifacts = findBlackholeArtifacts(sesId);
  const overridesByStage: Record<string, number> = {};
  const promptVersions = new Set<string>();
  for (const a of artifacts) {
    if (a.input.prompt_override === true) {
      overridesByStage[a.stage] = (overridesByStage[a.stage] || 0) + 1;
    }
    if (a.prompt_id) promptVersions.add(a.prompt_id);
  }
  const overrideStages = Object.entries(overridesByStage);
  if (overrideStages.length > 0) {
    const details = overrideStages.map(([s, c]) => `${s}=${c}`).join(", ");
    console.log(`  ${yellow("\u26a0")} prompt overrides active: ${details}`);
    if (promptVersions.size > 0) {
      console.log(`    versions: ${[...promptVersions].join(", ")}`);
    }
  } else if (artifacts.length > 0) {
    console.log(`  ${green("\u2713")} all stages using default prompts`);
  }

  // 4. Folded observations from compaction details
  const folded = extractFoldedObservations(entries);
  if (folded.count > 0) {
    console.log(`\n${bold("folded observations (from compaction)")}`);
    for (const o of folded.observations?.slice(0, 5) ?? []) {
      const label =
        o.relevance === "high" || o.relevance === "critical"
          ? yellow(`[${o.relevance}]`)
          : dim(`[${o.relevance}]`);
      console.log(
        `  ${dim("\u229f")} ${dim(o.id.slice(0, 12))} ${label}  ${truncate(o.content, 100)}`
      );
    }
    if ((folded.observations?.length ?? 0) > 5)
      console.log(
        `  ${dim("... and " + ((folded.observations?.length ?? 0) - 5) + " more")}`
      );
  }

  // 5. Unknown custom entry types
  const customTypes = [
    ...new Set(
      entries
        .filter((e) => e.type === "custom")
        .map((e) => (e as any).customType ?? "?")
    ),
  ];
  const knownTypes = new Set([
    "om.observations.recorded",
    "om.reflections.recorded",
    "om.observations.dropped",
    "session.index",
    "context_snapshot",
  ]);
  const unknown = customTypes.filter((t) => !knownTypes.has(t));
  if (unknown.length > 0) {
    console.log(
      `  ${yellow("?")} unknown custom types: ${unknown.join(", ")}`
    );
  } else {
    console.log(
      `  ${green("\u2713")} all custom entry types are recognized by bh`
    );
  }

  // 6. Message stats (now shown alongside tool calls above)
  console.log(`\n${bold("session stats")}`);
  const msgCount = entries.filter((e) => e.type === "message").length;
  console.log(`  ${msgCount} total messages`);
  console.log();

  // 7. Custom entry timeline
  const customEntries = entries.filter((e) => e.type === "custom");
  if (customEntries.length > 0) {
    console.log(`${bold("custom entry timeline:")}`);
    for (const ce of customEntries) {
      const ct = (ce as any).customType ?? "?";
      const ts = (ce as any).timestamp ?? "";
      const time = ts ? fmtTime(ts) : dim("?");
      const data = (ce as any).data ?? {};
      if (ct === "om.observations.recorded") {
        const count = (data as any).observations?.length ?? 0;
        console.log(`  ${green("+")} ${time} ${ct}  ${count} observations`);
      } else if (ct === "om.reflections.recorded") {
        const count = (data as any).reflections?.length ?? 0;
        console.log(`  ${cyan("\u25c6")} ${time} ${ct}  ${count} reflections`);
      } else if (ct === "om.observations.dropped") {
        const count = (data as any).observationIds?.length ?? 0;
        console.log(`  ${red("\u2717")} ${time} ${ct}  ${count} dropped`);
      } else {
        console.log(`  ${dim("\u00b7")} ${time} ${ct}`);
      }
    }
  }
  console.log();
}

// ─── Render (obsidian output) ──────────────────────────────────────────────

function slugify(text: string, maxLen = 55): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, maxLen)
    .replace(/-+$/g, "");
}

function uniqueSlug(text: string, used: Set<string>): string {
  let slug = slugify(text);
  if (!slug) slug = "untitled";
  let candidate = slug;
  for (let i = 2; used.has(candidate); i++) candidate = `${slug}-${i}`;
  used.add(candidate);
  return candidate;
}

/** Truncate text for link display labels, removing quotes/newlines. */
function displayText(text: string, maxLen = 60): string {
  return text
    .replace(/[\n\r]+/g, " ")
    .replace(/"/g, "'")
    .substring(0, maxLen)
    .replace(/\s+$/, "");
}

function cmdRender(spec: string) {
  const { path: sesPath, id: sesId } = findSession(spec);
  const entries = loadSessionEntries(sesPath);

  // Find last compaction with folded memory; fall back to recorded observations
  let compEntry: (CompactionEntry & { index: number }) | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as CompactionEntry;
    if (e.type === "compaction" && e.details?.["om.folded"]) {
      compEntry = { ...e, index: i };
      break;
    }
  }

  let refs: Array<{ id: string; content: string; supportingObservationIds?: string[] }> = [];
  let obs: Array<{ id: string; content: string; sourceEntryIds?: string[]; kind?: string }> = [];
  let summary = "";

  if (compEntry) {
    const folded = compEntry.details!["om.folded"]!;
    refs = folded.reflections ?? [];
    obs = folded.observations ?? [];
    summary = compEntry.summary ?? "";
  } else {
    // No compaction yet — build from latest recorded entries
    const seenRefIds = new Set<string>();
    const seenObsIds = new Set<string>();
    for (const e of entries) {
      if (e.type !== "custom") continue;
      const ce = e as any;
      if (ce.customType === "om.reflections.recorded" && ce.data?.reflections) {
        for (const r of ce.data.reflections) {
          if (!seenRefIds.has(r.id)) {
            seenRefIds.add(r.id);
            refs.push({ id: r.id, content: r.content, supportingObservationIds: r.supportingObservationIds });
          }
        }
      }
      if (ce.customType === "om.observations.recorded" && ce.data?.observations) {
        for (const o of ce.data.observations) {
          if (!seenObsIds.has(o.id)) {
            seenObsIds.add(o.id);
            obs.push({ id: o.id, content: o.content, sourceEntryIds: o.sourceEntryIds, kind: o.kind });
          }
        }
      }
    }
  }

  if (refs.length === 0 && obs.length === 0) {
    console.error("no observations or reflections found in session");
    process.exit(1);
  }

  // Build index of all source entries by ID
  const entryIndex = new Map<string, { entry: SessionEntry; line: number }>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.id) entryIndex.set(e.id, { entry: e, line: i + 1 });
  }

  // Collect unique source entry IDs from observations
  const sourceEntryIds = new Set<string>();
  for (const o of obs) {
    for (const eid of o.sourceEntryIds ?? []) sourceEntryIds.add(eid);
  }

  // Build reverse index: observation ID -> set of reflection IDs that cite it
  const obsToRefs = new Map<string, string[]>();
  for (const r of refs) {
    for (const oid of r.supportingObservationIds ?? []) {
      const list = obsToRefs.get(oid) ?? [];
      list.push(r.id);
      obsToRefs.set(oid, list);
    }
  }

  // Also collect observations cited by reflections but not in folded (already pruned)
  const citedObsIds = new Set<string>();
  for (const r of refs) {
    for (const oid of r.supportingObservationIds ?? []) citedObsIds.add(oid);
  }
  for (const o of obs) citedObsIds.delete(o.id); // already covered

  // Scan om.observations.recorded for pruned observations
  const prunedObs: Array<{ id: string; content: string; sourceEntryIds?: string[] }> = [];
  if (citedObsIds.size > 0) {
    for (const e of entries) {
      if (e.type !== "custom") continue;
      const ce = e as any;
      if (ce.customType !== "om.observations.recorded") continue;
      for (const o of (ce.data?.observations ?? [])) {
        if (citedObsIds.has(o.id)) {
          prunedObs.push({ id: o.id, content: o.content, sourceEntryIds: o.sourceEntryIds });
        }
      }
    }
  }

  // ─── Extract all compactions and bin OM data into epochs ──────────────
  const entryLine = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].id) entryLine.set(entries[i].id!, i);
  }

  // Extract all compactions
  const allCompactions: Array<{ id: string; index: number; entry: CompactionEntry }> = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as CompactionEntry;
    if (e.type === "compaction") {
      allCompactions.push({ id: e.id ?? `compaction-${allCompactions.length}`, index: i, entry: e });
    }
  }

  // Extract all raw OM items with their source entry line positions
  interface RawOMItem {
    id: string;
    content: string;
    sourceEntryIds?: string[];
    kind?: string;
    supportingObservationIds?: string[];
    entryLine: number;
  }
  const allRawObs: RawOMItem[] = [];
  const allRawRefs: RawOMItem[] = [];
  const allRawDrops: Array<{ observationIds: string[]; entryLine: number }> = [];

  for (const e of entries) {
    if (e.type !== "custom") continue;
    const ce = e as any;
    const eid = e.id;
    const line = eid ? (entryLine.get(eid) ?? -1) : -1;
    if (ce.customType === "om.observations.recorded" && ce.data?.observations) {
      for (const o of ce.data.observations) {
        allRawObs.push({ id: o.id, content: o.content, sourceEntryIds: o.sourceEntryIds, kind: o.kind, entryLine: line });
      }
    }
    if (ce.customType === "om.reflections.recorded" && ce.data?.reflections) {
      for (const r of ce.data.reflections) {
        allRawRefs.push({ id: r.id, content: r.content, supportingObservationIds: r.supportingObservationIds, entryLine: line });
      }
    }
    if (ce.customType === "om.observations.dropped" && ce.data?.observationIds) {
      allRawDrops.push({ observationIds: ce.data.observationIds, entryLine: line });
    }
  }

  // Bin into epochs
  const compactionLines = allCompactions.map(c => ({ line: c.index, comp: c })).sort((a, b) => a.line - b.line);

  function binItems<T extends { entryLine: number }>(items: T[]): T[][] {
    const bins: T[][] = Array.from({ length: compactionLines.length + 1 }, () => []);
    for (const item of items) {
      let placed = false;
      for (let bi = 0; bi < compactionLines.length; bi++) {
        if (item.entryLine < compactionLines[bi].line) {
          bins[bi].push(item);
          placed = true;
          break;
        }
      }
      if (!placed) bins[bins.length - 1].push(item);
    }
    return bins;
  }

  const obsBins = binItems(allRawObs);
  const refBins = binItems(allRawRefs);
  const dropBins = binItems(allRawDrops);

  const epochs: Array<{
    label: string;
    compaction: typeof allCompactions[0] | null;
    observations: typeof allRawObs;
    reflections: typeof allRawRefs;
    drops: typeof allRawDrops;
  }> = [];

  for (let i = 0; i < compactionLines.length; i++) {
    const label = i === 0 ? "birth \u2192 compaction 1" : `compaction ${i} \u2192 compaction ${i + 1}`;
    epochs.push({
      label,
      compaction: compactionLines[i].comp,
      observations: obsBins[i],
      reflections: refBins[i],
      drops: dropBins[i],
    });
  }
  // Final epoch
  epochs.push({
    label: compactionLines.length > 0 ? `compaction ${compactionLines.length} \u2192 end` : "birth \u2192 end",
    compaction: null,
    observations: obsBins[obsBins.length - 1],
    reflections: refBins[refBins.length - 1],
    drops: dropBins[dropBins.length - 1],
  });

  // Generate unique slugs for everything
  const usedSlugs = new Set<string>();
  const refSlug = new Map<string, string>(); // reflection id -> slug
  const obsSlug = new Map<string, string>(); // observation id -> slug
  const srcSlug = new Map<string, string>(); // source entry id -> slug
  
  for (const r of refs) refSlug.set(r.id, uniqueSlug(r.content, usedSlugs));
  for (const o of obs) obsSlug.set(o.id, uniqueSlug(o.content, usedSlugs));
  for (const o of prunedObs) obsSlug.set(o.id, uniqueSlug(o.content + " (pruned)", usedSlugs));

  // Add pruned observations' source entries to the set
  for (const o of prunedObs) {
    for (const eid of o.sourceEntryIds ?? []) sourceEntryIds.add(eid);
  }

  for (const eid of sourceEntryIds) {
    const src = entryIndex.get(eid);
    const label = src ? `${src.entry.type}-${src.line}` : eid.substring(0, 12);
    srcSlug.set(eid, uniqueSlug(label, usedSlugs));
  }



  // Session folder name: date + profile
  const dateMatch = sesPath.match(/(\d{4}-\d{2}-\d{2})/);
  const sesDate = dateMatch ? dateMatch[1] : "unknown-date";
  const profileMatch = sesPath.match(/profiles\/([^/]+)\/sessions/);
  const profileName = profileMatch ? profileMatch[1] : "";
  const sessionLabel = profileName
    ? sesDate + "_" + profileName
    : sesDate + "_" + sesId.substring(0, 8);
  // Session subfolder slug
  const tsMatch = sesPath.match(/(T\d{2}-\d{2}-\d{2})/);
  const ts = tsMatch ? tsMatch[1] : sesId.substring(0, 8);
  // Use first reflection content for label, fall back to summary goal, then UUID
  const firstRef = refs.length > 0 ? refs[0].content : null;
  const goalLine = (summary || "").match(/\[Session Goal\][\s\S]*?\n(- .+)/);
  const shortLabel = firstRef
    ? slugify(firstRef, 30)
    : goalLine
      ? slugify(goalLine[1].replace(/^- /, "").trim(), 30)
      : sesId.substring(0, 8);
  const sessionSlug = ts + "_" + shortLabel;
  const vaultBase = "blackhole/" + sessionLabel + "/" + sessionSlug;
  const baseDir = join(HOME, "vault", "blackhole", sessionLabel, sessionSlug);
  const refDir = join(baseDir, "ref");
  const obsDir = join(baseDir, "obs");
  const srcDir = join(baseDir, "src");

  const compDir = join(baseDir, "compactions");
  mkdirSync(refDir, { recursive: true });
  mkdirSync(obsDir, { recursive: true });
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(compDir, { recursive: true });

  
// Build full observation content lookup (folded + pruned)
  const obsContent = new Map<string, string>();
  for (const o of obs) obsContent.set(o.id, o.content);
  for (const o of prunedObs) obsContent.set(o.id, o.content);

  // Kind symbols
  const KIND_SYM: Record<string, string> = {
    objective: "⇲",
    intentional: "✦",
    reflexive: "⟳",
  };
  function kindBadge(kind?: string): string {
    if (!kind) return "";
    const sym = KIND_SYM[kind] ?? "?";
    return `${sym} **${kind}** `;
  }

  // Helper: build a vault-root-relative wikilink
  function wlink(relPath: string, label: string): string {
    return `[[${relPath}|${label}]]`;
  }
  function refLink(id: string): string {
    const slug = refSlug.get(id);
    if (!slug) return id.substring(0, 12);
    const r = refs.find((x) => x.id === id);
    const label = r ? r.content : slug;
    return wlink(vaultBase + "/ref/" + slug, label);
  }
  function obsLink(id: string): string {
    const slug = obsSlug.get(id);
    if (!slug) return id.substring(0, 12);
    const content = obsContent.get(id);
    const label = content ?? slug;
    return wlink(vaultBase + "/obs/" + slug, label);
  }
  function srcLink(eid: string): string {
    const slug = srcSlug.get(eid);
    if (!slug) return eid.substring(0, 12);
    const src = entryIndex.get(eid);
    if (!src) return wlink(vaultBase + "/src/" + slug, eid.substring(0, 12));
    const e = src.entry;
    let labelText = e.type;
    const msg = (e as any).message;
    const tc = (e as any).toolCall;
    const tr = (e as any).toolResult;
    const ct = (e as any).customType;
    if (msg?.role) labelText += " (" + msg.role + ")";
    if (tc?.name) labelText += ": " + tc.name;
    else if (tr?.toolName) labelText += ": " + tr.toolName;
    else if (ct) labelText += ": " + ct;
    const label = displayText(labelText, 60);
    return wlink(vaultBase + "/src/" + slug, label);
  }


  // Merge folded + pruned observations for output
  const allObs = [...obs, ...prunedObs.map((o) => ({ ...o, _pruned: true as const }))];



  // Build provenance tree per reflection: reflection -> obs -> source entry
  function provenanceTree(reflection: typeof refs[0]): string {
    const lines: string[] = [];
    lines.push("```");
    lines.push("provenance tree");
    lines.push("");
    for (const oid of reflection.supportingObservationIds ?? []) {
      const o = allObs.find(x => x.id === oid);
      if (!o) {
        lines.push(`  observation ${oid.substring(0,12)} (not in session)`);
        continue;
      }
      const k = o.kind ?? "?";
      const sym = KIND_SYM[k] ?? "?";
      lines.push(`  ${sym} ${k} ${displayText(o.content, 70)}`);
      for (const eid of (o.sourceEntryIds ?? [])) {
        const src = entryIndex.get(eid);
        if (!src) {
          lines.push(`    └ source ${eid.substring(0,12)} (not in session)`);
        } else {
          let label = src.entry.type;
          const msg = (src.entry as any).message;
          const tc = (src.entry as any).toolCall;
          const tr = (src.entry as any).toolResult;
          const ct = (src.entry as any).customType;
          if (msg?.role) label += " (" + msg.role + ")";
          else if (tc?.name) label += ": " + tc.name;
          else if (tr?.toolName) label += ": " + tr.toolName;
          else if (ct) label += ": " + ct;
          lines.push(`    └ source entry #${src.line} — ${label}`);
        }
      }
    }
    lines.push("```");
    return lines.join("\n");
  }

  // ─── Write reflection files ───────────────────────────────────────────
  for (const r of refs) {
    const slug = refSlug.get(r.id)!;
    const supporting = (r.supportingObservationIds ?? [])
      .map((oid) => {
        const o = allObs.find(x => x.id === oid);
        const kb = o ? kindBadge(o.kind) : "";
        return "- " + kb + obsLink(oid);
      })
      .join("\n");
    const provenance = provenanceTree(r);
    const content = `# ${displayText(r.content, 80)}

${r.content}

${supporting ? "## grounded in\n" + supporting : ""}

${provenance ? "## evidence chain\n\n" + provenance + "\n" : ""}

---
[[${vaultBase}/session|back to session]]
`;
    writeFileSync(join(refDir, slug + ".md"), content);
  }

  // ─── Write observation files ──────────────────────────────────────────
  for (const o of allObs) {
    const slug = obsSlug.get(o.id)!;
    const sources = (o.sourceEntryIds ?? [])
      .map((eid) => {
        const link = srcLink(eid);
        const src = entryIndex.get(eid);
        const typeInfo = src ? ` (${src.entry.type})` : "";
        return "- " + link + typeInfo;
      })
      .join("\n");
    const prunedNote = (o as any)._pruned ? "> *(pruned from working memory — preserved from recorded observations)*\n\n" : "";
    const citing = (obsToRefs.get(o.id) ?? [])
      .map((rid) => "- " + refLink(rid))
      .join("\n");
    const kb = kindBadge(o.kind);
    const content = `# ${kindBadge(o.kind)}${displayText(o.content, 70)}

${prunedNote}${o.content}

${sources ? "## from session entries\n" + sources : ""}



${citing ? "## cited by reflections\n" + citing : ""}

---
kind: ${o.kind ?? "—"} | [[${vaultBase}/session|back to session]]
`;
    writeFileSync(join(obsDir, slug + ".md"), content);
  }

  // ─── Write source entry files ─────────────────────────────────────────
  for (const eid of sourceEntryIds) {
    const slug = srcSlug.get(eid)!;
    const src = entryIndex.get(eid);
    if (!src) {
      writeFileSync(join(srcDir, slug + ".md"), `# source entry ${eid}\n\n*(not found in session log)*\n`);
      continue;
    }
    const e = src.entry;
    const json = JSON.stringify(e, null, 2);
    const citedBy = allObs
      .filter((o) => (o.sourceEntryIds ?? []).includes(eid))
      .map((o) => "- " + obsLink(o.id))
      .join("\n");
    const content = `# ${e.type} at line ${src.line}

id: \`${eid}\`

\`\`\`json
${json}
\`\`\`

${citedBy ? "## referenced by observations\n" + citedBy : ""}

---
back to session: [[${vaultBase}/session]]
`;
    writeFileSync(join(srcDir, slug + ".md"), content);
  }

  // ─── Load and write stage run artifacts ─────────────────────────────
  const artifacts = loadRunArtifacts(sesId);
  let stageList = "";
  const stageLinks: string[] = [];
  if (artifacts.length > 0) {
    const stageDir = join(baseDir, "stages");
    mkdirSync(stageDir, { recursive: true });
    for (const a of artifacts) {
      const tsSlug = a.timestamp.replace(/[:.]/g, "-").substring(0, 25);
      const stageSlug = tsSlug + "-" + a.stage;
      const stagePath = "stages/" + stageSlug;
      const lines: string[] = [];

      lines.push("# " + a.stage + " @ " + a.timestamp);
      lines.push("");
      const dur = a.durationMs != null ? " | **duration:** " + (a.durationMs / 1000).toFixed(1) + "s" : "";
      lines.push("**model:** " + a.model.provider + "/" + a.model.id + dur);
      lines.push("");

      // Input metadata (non-prompt fields)
      const metaKeys = Object.keys(a.input).filter(k => k !== "systemPrompt" && k !== "userPrompt");
      if (metaKeys.length > 0) {
        lines.push("## input metadata");
        lines.push("");
        for (const k of metaKeys) {
          const v = a.input[k];
          const formatted = typeof v === "number" ? v.toLocaleString() : v == null ? "—" : String(v);
          lines.push("- **" + k + "**: " + formatted);
        }
        lines.push("");
      }

      // System prompt
      const sysP = a.input.systemPrompt;
      if (typeof sysP === "string" && sysP.length > 0) {
        lines.push("### system prompt");
        lines.push("");
        lines.push("```");
        lines.push(sysP);
        lines.push("```");
        lines.push("");
      }

      // User prompt
      const usrP = a.input.userPrompt;
      if (typeof usrP === "string" && usrP.length > 0) {
        lines.push("### user prompt");
        lines.push("");
        lines.push("```");
        lines.push(usrP);
        lines.push("```");
        lines.push("");
      }

      // Output
      lines.push("## output");
      const out = a.output;
      if (a.stage === "observer") {
        const obsOut = (out as any).observations;
        const emptyR = (out as any).emptyReason;
        if (obsOut && obsOut.length > 0) {
          lines.push("");
          lines.push("**" + obsOut.length + " observations:**");
          lines.push("");
          for (const o of obsOut) {
            const kindTag = o.kind ? " (" + o.kind + ")" : "";
            lines.push("- **" + o.relevance + "** " + o.content + kindTag);
          }
        } else if (emptyR) {
          lines.push("");
          lines.push("*(skipped)* — " + emptyR);
        }
      } else if (a.stage === "reflector") {
        const refOut = (out as any).reflections;
        if (refOut && refOut.length > 0) {
          lines.push("");
          lines.push("**" + refOut.length + " reflections:**");
          lines.push("");
          for (const r of refOut) {
            lines.push("- " + r.content);
          }
        }
      } else if (a.stage === "dropper") {
        const dropped = (out as any).droppedIds;
        lines.push("");
        if (dropped && dropped.length > 0) {
          lines.push("**dropped " + dropped.length + " observations:**");
          lines.push("");
          for (const did of dropped) {
            lines.push("- " + did);
          }
        } else {
          lines.push("*(no observations dropped)*");
        }
        lines.push("- kept: " + (out as any).keptCount);
      }
      lines.push("");
      lines.push("---");
      lines.push("back to session: [[" + vaultBase + "/session]]");

      writeFileSync(join(stageDir, stageSlug + ".md"), lines.join("\n"));
      const shortTs = a.timestamp.length >= 16 ? a.timestamp.substring(11, 19) : a.timestamp;
      stageLinks.push("- [[" + vaultBase + "/" + stagePath + "|" + a.stage + " @ " + shortTs + "]]");
    }
    // Group by stage for summary counts
    const stageCounts: Record<string, number> = {};
    for (const a of artifacts) {
      stageCounts[a.stage] = (stageCounts[a.stage] || 0) + 1;
    }
    const summaryParts: string[] = [];
    for (const s of ["observer", "reflector", "dropper"]) {
      if (stageCounts[s]) summaryParts.push(s + ": " + stageCounts[s] + " runs");
    }
    // Write stages index
    const stageIndexContent = "# Pipeline stages\n\n"
      + "session: [[" + vaultBase + "/session]]\n\n"
      + "total runs: " + artifacts.length + "\n\n"
      + "## by type\n\n"
      + summaryParts.map(s => "- " + s).join("\n") + "\n\n"
      + "## timeline\n\n"
      + stageLinks.join("\n") + "\n";
    writeFileSync(join(stageDir, "index.md"), stageIndexContent);

    stageList = "## Pipeline stages\n\n"
      + summaryParts.join(" · ") + "\n\n"
      + "[[" + vaultBase + "/stages/index|View full stage timeline →]]\n";
  }

  // ─── Write compaction files ────────────────────────────────────────────
  const compactionLinks: string[] = [];
  for (const epoch of epochs) {
    const comp = epoch.compaction;
    if (!comp) continue;
    const c = comp.entry;
    const cid = comp.id;
    const ts = c.timestamp?.substring(0, 19).replace("T", " ") ?? "?";
    const tokens = (c as any).tokensBefore ?? 0;
    const details = c.details as any;
    const folded = details?.["om.folded"];
    const foldedObs = folded?.observations?.length ?? 0;
    const foldedRefs = folded?.reflections?.length ?? 0;
    const sourceCount = details?.sourceMessageCount ?? 0;
    const sections = details?.sections ?? [];
    const prevUsed = details?.previousSummaryUsed ?? false;
    const totalDroppedIds = epoch.drops.reduce((sum, d) => sum + d.observationIds.length, 0);
    const summaryText = c.summary ?? "";

    const epochObsList = epoch.observations.length > 0
      ? epoch.observations.map(o => {
          const kind = o.kind ?? "objective";
          const sym = KIND_SYM[kind] ?? "⇲";
          const slug = obsSlug.get(o.id);
          return `- ${sym} [[${vaultBase}/obs/${slug ?? o.id.substring(0, 12)}|${displayText(o.content, 80)}]]`;
        }).join("\n")
      : "*(none)*";

    const epochRefList = epoch.reflections.length > 0
      ? epoch.reflections.map(r => {
          const slug = refSlug.get(r.id);
          const supportLinks = (r.supportingObservationIds ?? [])
            .map(sid => `[[${vaultBase}/obs/${obsSlug.get(sid) ?? sid.substring(0, 12)}]]`)
            .join(", ");
          return `- [[${vaultBase}/ref/${slug ?? r.id.substring(0, 12)}|${displayText(r.content, 80)}]]${supportLinks ? `\n  - supporting: ${supportLinks}` : ""}`;
        }).join("\n")
      : "*(none)*";

    const epochDropList = epoch.drops.length > 0
      ? epoch.drops.map((d, i) => {
          const droppedLinks = d.observationIds
            .map(did => `[[${vaultBase}/obs/${obsSlug.get(did) ?? did.substring(0, 12)}]]`)
            .join(", ");
          return `- run ${i + 1}${droppedLinks ? `: dropped ${droppedLinks}` : ": *(no drops)*"}`;
        }).join("\n")
      : "*(none)*";

    const content = `---
session: ${sessionLabel}
session_id: "${sesId}"
compaction_id: "${cid}"
timestamp: ${ts}
tokens_before: ${tokens}
source_messages: ${sourceCount}
sections: ${JSON.stringify(sections)}
om_folded_observations: ${foldedObs}
om_folded_reflections: ${foldedRefs}
previous_summary_used: ${String(prevUsed)}
epoch: "${epoch.label}"
epoch_observations: ${epoch.observations.length}
epoch_reflections: ${epoch.reflections.length}
epoch_dropper_runs: ${epoch.drops.length}
epoch_dropped_ids: ${totalDroppedIds}
---

# compaction \`${cid}\`

**when**: ${ts} · **tokens before**: ${tokens.toLocaleString()}

## summary

${summaryText.trim() || "*(empty)*"}

---

## epoch: ${epoch.label}

### observations (${epoch.observations.length})

${epochObsList}

### reflections (${epoch.reflections.length})

${epochRefList}

### dropper runs (${epoch.drops.length})

${epochDropList}

---
back to session: [[${vaultBase}/session]]
`;
    const fname = `compaction_${cid}.md`;
    writeFileSync(join(compDir, fname), content);
    const tsShort = ts.substring(11, 19);
    const compLabel = epoch.label.includes("→")
      ? epoch.label.split("→")[0].trim().replace("compaction ", "#")
      : epoch.label;
    compactionLinks.push(`- [[${vaultBase}/compactions/${fname}|compaction ${compLabel}]] — ${tsShort} · ${tokens.toLocaleString()} tok`);
  }

// ─── Write session entry point ────────────────────────────────────────
  function obsListItem(o: typeof obs[0] & { _pruned?: boolean }): string {
    const sym = o.kind ? (KIND_SYM[o.kind] ?? "?") : "";
    const prunedTag = (o as any)._pruned ? " *(pruned)*" : "";
    return `- ${sym} ${obsLink(o.id)}${prunedTag}`;
  }
  const foldedObsList = obs
    .map((o) => obsListItem(o))
    .join("\n");
  const prunedObsList = prunedObs
    .map((o) => obsListItem({ ...o, _pruned: true }))
    .join("\n");
  const refList = refs
    .map((r) => "- " + refLink(r.id))
    .join("\n");

  // stats
  let totalObs = 0, totalRef = 0, totalDrop = 0;
  const kindCounts: Record<string, number> = {};
  for (const e of entries) {
    if (e.type === "custom") {
      const ce = e as any;
      if (ce.customType === "om.observations.recorded") {
        for (const o of (ce.data?.observations ?? [])) {
          totalObs++;
          if (o.kind) kindCounts[o.kind] = (kindCounts[o.kind] || 0) + 1;
        }
      }
      if (ce.customType === "om.reflections.recorded") totalRef += (ce.data?.reflections ?? []).length;
      if (ce.customType === "om.observations.dropped") totalDrop += (ce.data?.observationIds ?? []).length;
    }
  }
  // kind distribution for folded survivors too
  const foldedKindCounts: Record<string, number> = {};
  for (const o of obs) {
    if (o.kind) foldedKindCounts[o.kind] = (foldedKindCounts[o.kind] || 0) + 1;
  }
  function kindBar(counts: Record<string, number>): string {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total === 0) return "(no kind data)";
    const parts = [];
    for (const k of ["objective", "intentional", "reflexive"]) {
      const c = counts[k] ?? 0;
      const pct = Math.round(c / total * 100);
      const bar = "█".repeat(Math.round(pct / 10));
      const sym = KIND_SYM[k] ?? "?";
      if (c > 0) parts.push(`${sym} ${k}: ${c} (${pct}%) ${bar}`);
    }
    return parts.join("\n");
  }

  // Show only the structured header section of the summary
  const summaryLines = (summary || "").split("\n");
  const structuredEnd = summaryLines.findIndex(
    (l) => l.startsWith("[") && l !== "[Session Goal]" && l !== "[Files And Changes]" && l !== "[Commits]"
  );
  const headerLines = structuredEnd > 0 ? summaryLines.slice(0, structuredEnd) : summaryLines.slice(0, 15);
  const summaryHeader = headerLines.join("\n").trim();
  const fullSummaryIncluded = headerLines.length < summaryLines.length;

  const compactionStats = allCompactions.length > 0
    ? `\n- compactions: ${allCompactions.length}`
    : "";

  const compactionsSection = compactionLinks.length > 0
    ? `## Compactions (${allCompactions.length})

${compactionLinks.join("\n")}\n`
    : "";

  const sessionNote = `# Session: ${sessionLabel}

${summaryHeader || "*(no compaction summary)*"}

${fullSummaryIncluded ? `> Full compaction summary available (\`bh overview ${sesId.substring(0,12)}\` for CLI view)
` : ""}
---

## Stats
- session id: \`${sesId}\`
- total entries: ${entries.length}${compactionStats}
- observations recorded: ${totalObs}
- reflections recorded: ${totalRef}
- observations pruned: ${totalDrop}
- folded survivors: ${obs.length} observations, ${refs.length} reflections
- observations cited by reflections (incl. pruned): ${allObs.length}

### epistemic kind distribution (all recorded)
${kindBar(kindCounts)}

### epistemic kind distribution (folded survivors)
${kindBar(foldedKindCounts)}

## Reflections (${refs.length})

${refList}

## Observations — survivors (${obs.length})

${foldedObsList}

${prunedObs.length > 0 ? `## Observations — pruned but cited (${prunedObs.length})

${prunedObsList}
` : ""}

${compactionsSection}

${stageList}`;
  writeFileSync(join(baseDir, "session.md"), sessionNote);

  console.log(`\nwrote ${refs.length} reflections, ${obs.length} observations, ${sourceEntryIds.size} sources, ${allCompactions.length} compactions to ${baseDir}`);
  console.log(`open obsidian at ~/vault/ and navigate to ${vaultBase}/session.md`);
}

// ─── Run artifact loader ──────────────────────────────────────────────────────

function loadRunArtifacts(sessionId: string): StageArtifact[] {
  const artifacts: StageArtifact[] = [];
  const candidates = [
    join(HOME, ".pi", "blackhole", "runs", sessionId),
    join(process.cwd(), ".pi", "blackhole", "runs", sessionId),
  ];
  for (const dir of candidates) {
    try {
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir).filter(f => f.endsWith(".json"));
      for (const f of files) {
        try {
          const content = readFileSync(join(dir, f), "utf-8");
          artifacts.push(JSON.parse(content));
        } catch { /* skip unparseable */ }
      }
    } catch { /* skip inaccessible */ }
  }
  artifacts.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return artifacts;
}

// ─── Provenance ──────────────────────────────────────────────────────────────

function cmdProvenance(spec: string) {
  const { path: sesPath, id: sesId } = findSession(spec);
  const artifacts = findBlackholeArtifacts(sesId);

  console.log(`\n${bold("bh provenance")}  ${dim(sesId)} \u2014 prompt versions & overrides\n`);

  if (artifacts.length === 0) {
    console.log(`  ${dim("no pipeline artifacts found")}\n`);
    return;
  }

  // Group by stage and prompt version
  const byStage: Record<string, StageArtifact[]> = {};
  for (const a of artifacts) {
    (byStage[a.stage] ??= []).push(a);
  }

  const stages = ["observer", "reflector", "dropper"] as const;
  for (const stage of stages) {
    const runs = byStage[stage];
    if (!runs || runs.length === 0) continue;

    // Collect unique prompt configurations used
    const promptConfigs = new Map<string, { count: number; hasOverride: boolean; promptId?: string; model: string }>();
    for (const a of runs) {
      const sysPrompt = a.input.systemPrompt as string | undefined;
      const key = sysPrompt ? sysPrompt.slice(0, 80) : "(default)";
      const existing = promptConfigs.get(key);
      if (existing) {
        existing.count++;
      } else {
        promptConfigs.set(key, {
          count: 1,
          hasOverride: (a.input.prompt_override as boolean) === true,
          promptId: a.prompt_id,
          model: `${a.model.provider}/${a.model.id}`,
        });
      }
    }

    console.log(`${bold(stage)}  (${runs.length} runs)`);
    let idx = 0;
    for (const [key, cfg] of promptConfigs) {
      idx++;
      const overrideTag = cfg.hasOverride ? yellow(" [OVERRIDE]") : dim(" [default]");
      const versionTag = cfg.promptId ? cyan(` v=${cfg.promptId}`) : "";
      const modelTag = dim(`  model: ${cfg.model}`);
      console.log(`  ${idx}. ${dim(String(cfg.count) + "x")}${overrideTag}${versionTag}${modelTag}`);

      // Show first 3 lines of prompt if it's an override
      if (cfg.hasOverride && key !== "(default)") {
        const lines = key.split("\n").filter(l => l.trim()).slice(0, 3);
        for (const l of lines) {
          console.log(`     ${dim(truncate(l, 100))}`);
        }
        if (key.split("\n").filter(l => l.trim()).length > 3) {
          console.log(`     ${dim("...")}`);
        }
      }
    }

    // Show model distribution
    const models = new Map<string, number>();
    for (const a of runs) {
      const m = `${a.model.provider}/${a.model.id}`;
      models.set(m, (models.get(m) || 0) + 1);
    }
    if (models.size > 1) {
      console.log(`  models: ${[...models].map(([m, c]) => `${m} (${c}x)`).join(", ")}`);
    }
    console.log();
  }

  // Summary
  const overrideCount = artifacts.filter(a => a.input.prompt_override === true).length;
  const withPromptId = artifacts.filter(a => a.prompt_id !== undefined).length;
  console.log(`${bold("summary")}`);
  console.log(`  total artifacts: ${artifacts.length}`);
  console.log(`  with prompt overrides: ${overrideCount > 0 ? yellow(String(overrideCount)) : dim("0")}`);
  console.log(`  with prompt version ids: ${withPromptId > 0 ? cyan(String(withPromptId)) : dim("0")}`);
  console.log();
}

// ─── Epochs ──────────────────────────────────────────────────────────────────

function cmdEpochs(spec: string) {
  const { path: sesPath, id: sesId } = findSession(spec);
  const entries = loadSessionEntries(sesPath);
  const artifacts = findBlackholeArtifacts(sesId);

  console.log(`\n${bold("bh epochs")}  ${dim(sesId)} \u2014 compaction-bounded memory epochs\n`);

  // Find compactions
  const compactions: Array<{ id: string; index: number; ts: string; tokens: number; foldedObs: number; foldedRefs: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as any;
    if (e.type !== "compaction") continue;
    const folded = e.details?.["om.folded"];
    compactions.push({
      id: e.id ?? `compaction-${i}`,
      index: i,
      ts: e.timestamp ?? "?",
      tokens: e.tokensBefore ?? 0,
      foldedObs: folded?.observations?.length ?? 0,
      foldedRefs: folded?.reflections?.length ?? 0,
    });
  }

  // Extract OM entries with their positions
  interface OMPos { entryId: string; type: string; idx: number; count: number }
  const omEntries: OMPos[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as any;
    if (e.type !== "custom") continue;
    const ct = e.customType;
    if (ct === "om.observations.recorded") {
      omEntries.push({ entryId: e.id ?? "?", type: "obs", idx: i, count: (e.data?.observations ?? []).length });
    } else if (ct === "om.reflections.recorded") {
      omEntries.push({ entryId: e.id ?? "?", type: "refl", idx: i, count: (e.data?.reflections ?? []).length });
    } else if (ct === "om.observations.dropped") {
      omEntries.push({ entryId: e.id ?? "?", type: "drop", idx: i, count: (e.data?.observationIds ?? []).length });
    }
  }

  if (compactions.length === 0) {
    console.log(`  ${dim("no compactions — single epoch")}\n`);
    // Still show OM summary
    const totalObs = omEntries.filter(e => e.type === "obs").reduce((s, e) => s + e.count, 0);
    const totalRefl = omEntries.filter(e => e.type === "refl").reduce((s, e) => s + e.count, 0);
    const totalDrop = omEntries.filter(e => e.type === "drop").reduce((s, e) => s + e.count, 0);
    console.log(`  ${pad("birth \u2192 end:", 24)} ${green(`+${totalObs} obs`)}  ${cyan(`+${totalRefl} refl`)}  ${red(`-${totalDrop} dropped`)}`);
    console.log();
    return;
  }

  // Bin OM entries into epochs
  console.log(`${pad("epoch", 24)} ${pad("obs", 10)} ${pad("refl", 10)} ${pad("dropped", 10)} ${pad("folded", 10)} tokens\n`);

  let epochStart = 0;
  for (let ei = 0; ei <= compactions.length; ei++) {
    const isLast = ei === compactions.length;
    const comp = isLast ? null : compactions[ei];
    const epochEnd = isLast ? entries.length : comp!.index;

    // Count OM in this epoch
    let obs = 0, refl = 0, drop = 0;
    for (const om of omEntries) {
      if (om.idx < epochStart) continue;
      if (om.idx >= epochEnd) continue;
      if (om.type === "obs") obs += om.count;
      else if (om.type === "refl") refl += om.count;
      else if (om.type === "drop") drop += om.count;
    }

    const label = isLast
      ? `compaction ${ei} \u2192 end`
      : ei === 0
        ? "birth \u2192 compaction 1"
        : `compaction ${ei} \u2192 compaction ${ei + 1}`;

    const obsStr = obs > 0 ? green(`+${obs}`) : dim("\u00b7");
    const reflStr = refl > 0 ? cyan(`+${refl}`) : dim("\u00b7");
    const dropStr = drop > 0 ? red(`-${drop}`) : dim("\u00b7");

    const compInfo = comp
      ? `${comp.foldedObs > 0 ? yellow(String(comp.foldedObs) + " obs") : dim("\u00b7")} ${comp.foldedRefs > 0 ? cyan(String(comp.foldedRefs) + " refl") : ""}`.trim() || dim("\u00b7")
      : dim("\u00b7");
    const tokenInfo = comp ? `${comp.tokens.toLocaleString()} tok` : "";

    console.log(`  ${pad(label, 24)} ${pad(obsStr, 10)} ${pad(reflStr, 10)} ${pad(dropStr, 10)} ${pad(compInfo, 10)} ${dim(tokenInfo)}`);

    if (comp) {
      console.log(`    ${dim("\u2514 compaction")} ${comp.id.slice(0, 16)}  ${comp.ts.slice(0, 19)}`);
    }

    if (!isLast) epochStart = comp!.index + 1;
  }
  console.log();
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`
${bold("bh")} \u2014 blackhole session forensics

${bold("usage:")}
  bh overview    <session>      One-shot session + pipeline summary
  bh trace       <session>      Observation/reflection lifecycle across passes
  bh passes      <session>      Pass-by-pass stats table
  bh pipeline    <session>      Stage timing visualization
  bh drift       <session>      What got dropped (and when)
  bh snapshot    <session> <n>  Full state at pass N
  bh gaps        <session>      Anomalies, unknown types, session metadata
  bh provenance  <session>      Prompt versions, hashes, and overrides per stage
  bh epochs      <session>      Compaction-bounded memory epochs
  bh render      <session>      Export to Obsidian vault markdown

${dim("session can be a UUID or path to a .jsonl file")}
`);
    return;
  }

  const cmd = args[0];
  const spec = args[1];

  if (!spec) {
    console.error("missing session specifier");
    process.exit(1);
  }

  switch (cmd) {
    case "overview":
      cmdOverview(spec);
      break;
    case "trace":
      cmdTrace(spec);
      break;
    case "passes":
      cmdPasses(spec);
      break;
    case "pipeline":
      cmdPipeline(spec);
      break;
    case "drift":
      cmdDrift(spec);
      break;
    case "snapshot": {
      const n = parseInt(args[2] ?? "", 10);
      if (isNaN(n)) {
        console.error("pass number required");
        process.exit(1);
      }
      cmdSnapshot(spec, n);
      break;
    }
    case "gaps":
      cmdGaps(spec);
      break;
    case "provenance":
      cmdProvenance(spec);
      break;
    case "epochs":
      cmdEpochs(spec);
      break;
    case "render":
      cmdRender(spec);
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      console.log(
        `try: overview, trace, passes, pipeline, drift, snapshot, gaps, render`
      );
      process.exit(1);
  }
}

main();
