import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { getModel, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { runDropper, type DropperResult } from "./om/agents/dropper/agent.js";
import { runObserver, type ObserverResult } from "./om/agents/observer/agent.js";
import { runReflector, type ReflectorResult } from "./om/agents/reflector/agent.js";
import {
	observationToSummaryLine,
	reflectionToSummaryLine,
	type Observation,
	type Reflection,
} from "./om/ledger/index.js";

export interface ReplayArgs {
	jsonlPath: string;
	model: { provider: string; id: string; baseUrl?: string; api?: string };
	apiKey: string;
	headers?: Record<string, string>;
	promptOverrides?: {
		observer?: string;
		reflector?: string;
		dropper?: string;
	};
	thinkingLevel?: string;
	maxTurns?: number;
}

export interface ReplayResult {
	sessionId: string;
	sessionSlug: string;
	profile: string;
	epochs: ReplayEpoch[];
	allObservations: ObservationRecord[];
	allReflections: ReflectionRecord[];
	survivingObservations: ObservationRecord[];
	survivingReflections: ReflectionRecord[];
}

export interface ReplayEpoch {
	label: string;
	compactionId?: string;
	stages: ReplayStage[];
}

export type ReplayStage = ObserverStage | ReflectorStage | DropperStage;

export interface ObserverStage {
	type: "observer";
	timestamp: string;
	model: { provider: string; id: string };
	chunkEntryCount: number;
	newObservations: ObservationRecord[];
	promptUsed: { system: string; user: string };
}

export interface ReflectorStage {
	type: "reflector";
	timestamp: string;
	model: { provider: string; id: string };
	newReflections: ReflectionRecord[];
	promptUsed: { system: string; user: string };
}

export interface DropperStage {
	type: "dropper";
	timestamp: string;
	model: { provider: string; id: string };
	droppedIds: string[];
	dropReasons: Record<string, string>;
	promptUsed: { system: string; user: string };
}

export interface ObservationRecord {
	id: string;
	content: string;
	kind: string;
	relevance: string;
	timestamp: string;
	tokenCount: number;
	sourceEntryIds: string[];
	runIndex: number;
}

export interface ReflectionRecord {
	id: string;
	content: string;
	timestamp: string;
	supportingObservationIds: string[];
	runIndex: number;
}

type JsonRecord = Record<string, unknown>;

type ReplayState = {
	sourceEntries: JsonRecord[];
	activeObservations: ObservationRecord[];
	activeReflections: ReflectionRecord[];
	allObservations: ObservationRecord[];
	allReflections: ReflectionRecord[];
	droppedObservationIds: Set<string>;
	foldedObservationIds: Set<string>;
	foldedReflectionIds: Set<string>;
	runIndex: { observer: number; reflector: number; dropper: number };
};

const DEFAULT_THINKING_LEVEL = "low";
const DEFAULT_MAX_TURNS = 5;
const DEFAULT_OBSERVATION_POOL_BUDGET_TOKENS = 20_000;
const UNKNOWN_TIMESTAMP = "";
const UNKNOWN_SESSION_ID = "unknown-session";
const UNKNOWN_PROFILE = "unknown";

function isRecord(value: unknown): value is JsonRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseJsonl(content: string): JsonRecord[] {
	const entries: JsonRecord[] = [];
	for (const line of content.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const parsed: unknown = JSON.parse(line) as unknown;
		if (isRecord(parsed)) entries.push(parsed);
	}
	return entries;
}

function entryType(entry: JsonRecord): string | undefined {
	return stringValue(entry.type);
}

function customType(entry: JsonRecord): string | undefined {
	return stringValue(entry.customType);
}

function entryId(entry: JsonRecord): string | undefined {
	return stringValue(entry.id);
}

function entryTimestamp(entry: JsonRecord): string {
	return stringValue(entry.timestamp) ?? UNKNOWN_TIMESTAMP;
}

function findSessionEntry(entries: readonly JsonRecord[]): JsonRecord | undefined {
	return entries.find((entry) => entryType(entry) === "session");
}

function sessionSlugFromPath(jsonlPath: string): string {
	const file = basename(jsonlPath);
	const ext = extname(file);
	return ext ? file.slice(0, -ext.length) : file;
}

function contentToText(content: unknown): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block): string => {
				if (!isRecord(block)) return "[non-text content omitted]";
				if (block.type === "text" && typeof block.text === "string") return block.text;
				if (block.type === "toolCall") {
					const name = typeof block.name === "string" ? block.name : "tool";
					return `[${name}(${JSON.stringify(block.arguments ?? {})})]`;
				}
				if (block.type === "thinking" && typeof block.thinking === "string") return `[thinking: ${block.thinking}]`;
				return "[non-text content omitted]";
			})
			.filter((part) => part.length > 0)
			.join("\n");
	}
	return JSON.stringify(content);
}

function messageRole(entry: JsonRecord): string {
	const message = entry.message;
	if (!isRecord(message)) return "message";
	return stringValue(message.role) ?? "message";
}

function serializeMessageEntry(entry: JsonRecord): string {
	const message = entry.message;
	if (!isRecord(message)) return contentToText(entry.content);
	const role = messageRole(entry);
	if (role === "toolResult") {
		const toolName = stringValue(message.toolName) ?? "tool";
		return `toolResult ${toolName}: ${contentToText(message.content)}`;
	}
	return `${role}: ${contentToText(message.content)}`;
}

function serializeToolLikeEntry(entry: JsonRecord): string {
	const output = entry.output ?? entry.result ?? entry.content ?? entry.data;
	return `toolResult: ${contentToText(output)}`;
}

function isSourceEntry(entry: JsonRecord): boolean {
	const type = entryType(entry);
	if (type === "message") return true;
	return type === "tool_call" || type === "tool_result" || type === "toolCall" || type === "toolResult";
}

function serializeSourceEntries(entries: readonly JsonRecord[]): { chunk: string; sourceEntryIds: string[] } {
	const blocks: string[] = [];
	const sourceEntryIds: string[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		const id = entryId(entry) ?? `source-${index + 1}`;
		const rendered = entryType(entry) === "message" ? serializeMessageEntry(entry) : serializeToolLikeEntry(entry);
		if (!rendered.trim()) continue;
		sourceEntryIds.push(id);
		blocks.push(`[Source entry id: ${id}]\n${rendered}`);
	}
	return { chunk: blocks.join("\n\n"), sourceEntryIds };
}

function isObserverMarker(entry: JsonRecord): boolean {
	return entryType(entry) === "custom" && customType(entry) === "om.observations.recorded";
}

function isReflectorMarker(entry: JsonRecord): boolean {
	return entryType(entry) === "custom" && customType(entry) === "om.reflections.recorded";
}

function isDropperMarker(entry: JsonRecord): boolean {
	return entryType(entry) === "custom" && customType(entry) === "om.observations.dropped";
}

function isCompactionEntry(entry: JsonRecord): boolean {
	return entryType(entry) === "compaction";
}

function observationSummaryLine(observation: ObservationRecord): string {
	return observationToSummaryLine(observation as unknown as Observation);
}

function reflectionSummaryLine(reflection: ReflectionRecord): string {
	return reflectionToSummaryLine(reflection as unknown as Reflection);
}

function toObservationRecord(observation: Observation, runIndex: number): ObservationRecord {
	return {
		id: observation.id,
		content: observation.content,
		kind: observation.kind ?? "objective",
		relevance: observation.relevance,
		timestamp: observation.timestamp,
		tokenCount: observation.tokenCount,
		sourceEntryIds: observation.sourceEntryIds,
		runIndex,
	};
}

function toReflectionRecord(reflection: Reflection, runIndex: number, timestamp: string): ReflectionRecord {
	return {
		id: reflection.id,
		content: reflection.content,
		timestamp,
		supportingObservationIds: reflection.supportingObservationIds,
		runIndex,
	};
}

function observationRecordsAsLedger(observations: readonly ObservationRecord[]): Observation[] {
	return observations.map((observation) => ({
		id: observation.id,
		content: observation.content,
		timestamp: observation.timestamp,
		relevance: observation.relevance as Observation["relevance"],
		sourceEntryIds: observation.sourceEntryIds,
		tokenCount: observation.tokenCount,
		kind: observation.kind as Observation["kind"],
	}));
}

function reflectionRecordsAsLedger(reflections: readonly ReflectionRecord[]): Reflection[] {
	return reflections.map((reflection) => ({
		id: reflection.id,
		content: reflection.content,
		supportingObservationIds: reflection.supportingObservationIds,
		tokenCount: Math.ceil(reflection.content.length / 4),
	}));
}

function reflectedObservationIds(reflections: readonly ReflectionRecord[]): Set<string> {
	const ids = new Set<string>();
	for (const reflection of reflections) {
		for (const observationId of reflection.supportingObservationIds) ids.add(observationId);
	}
	return ids;
}

function promptFromObserverResult(result: ObserverResult): { system: string; user: string } {
	return result.prompt;
}

function promptFromReflectorResult(result: ReflectorResult | undefined): { system: string; user: string } {
	return result?.prompt ?? { system: "", user: "" };
}

function promptFromDropperResult(result: DropperResult | undefined): { system: string; user: string } {
	return result?.prompt ?? { system: "", user: "" };
}

function startEpoch(index: number): ReplayEpoch {
	return { label: `epoch-${index}`, stages: [] };
}

function foldAtCompaction(state: ReplayState): void {
	// Compaction is a context-window concern, not a memory-quality concern.
	// The benchmark measures what the memory pipeline (observer/reflector/dropper)
	// preserves, not what the VCC context compactor trims for token budget.
	// We keep epoch boundaries as structural markers but do NOT fold active memory.
	// Surviving memory = what survived dropper stages across all epochs.
	state.sourceEntries = [];
}

function resolveReplayModel(modelRef: { provider: string; id: string; baseUrl?: string; api?: string }): Model<any> {
	const resolved = getModel(modelRef.provider as never, modelRef.id as never) as Model<any> | undefined;
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
		contextWindow: 128_000,
		maxTokens: 32_000,
	};
}

function addObservations(state: ReplayState, observations: ObservationRecord[]): void {
	state.allObservations.push(...observations);
	state.activeObservations.push(...observations);
}

function addReflections(state: ReplayState, reflections: ReflectionRecord[]): void {
	state.allReflections.push(...reflections);
	state.activeReflections.push(...reflections);
}

function dropObservations(state: ReplayState, droppedIds: readonly string[]): void {
	for (const id of droppedIds) state.droppedObservationIds.add(id);
	const dropped = new Set(droppedIds);
	state.activeObservations = state.activeObservations.filter((observation) => !dropped.has(observation.id));
}

export async function replaySession(args: ReplayArgs): Promise<ReplayResult> {
	const text = await readFile(args.jsonlPath, "utf8");
	const entries = parseJsonl(text);
	const sessionEntry = findSessionEntry(entries);
	const sessionId = stringValue(sessionEntry?.id) ?? UNKNOWN_SESSION_ID;
	const sessionSlug = stringValue(sessionEntry?.slug) ?? stringValue(sessionEntry?.sessionSlug) ?? sessionSlugFromPath(args.jsonlPath);
	const profile = stringValue(sessionEntry?.profile) ?? UNKNOWN_PROFILE;
	const thinkingLevel = (args.thinkingLevel ?? DEFAULT_THINKING_LEVEL) as ModelThinkingLevel;
	const maxTurns = args.maxTurns ?? DEFAULT_MAX_TURNS;
	const model = resolveReplayModel(args.model);
	const modelInfo = { provider: model.provider, id: model.id };
	const state: ReplayState = {
		sourceEntries: [],
		activeObservations: [],
		activeReflections: [],
		allObservations: [],
		allReflections: [],
		droppedObservationIds: new Set<string>(),
		foldedObservationIds: new Set<string>(),
		foldedReflectionIds: new Set<string>(),
		runIndex: { observer: 0, reflector: 0, dropper: 0 },
	};
	const epochs: ReplayEpoch[] = [];
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
				...(args.promptOverrides?.observer !== undefined ? { systemPrompt: args.promptOverrides.observer } : {}),
			});
			const newObservations = (result.observations ?? []).map((observation) =>
				toObservationRecord(observation, state.runIndex.observer)
			);
			addObservations(state, newObservations);
			currentEpoch.stages.push({
				type: "observer",
				timestamp: entryTimestamp(entry),
				model: modelInfo,
				chunkEntryCount: state.sourceEntries.length,
				newObservations,
				promptUsed: promptFromObserverResult(result),
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
				existingReflectionsSummary: state.activeReflections.map(reflectionSummaryLine).join("\n") || undefined,
				thinkingLevel,
				maxTurns,
				...(args.promptOverrides?.reflector !== undefined ? { systemPrompt: args.promptOverrides.reflector } : {}),
			});
			const newReflections = (result?.reflections ?? []).map((reflection) =>
				toReflectionRecord(reflection, state.runIndex.reflector, entryTimestamp(entry))
			);
			addReflections(state, newReflections);
			currentEpoch.stages.push({
				type: "reflector",
				timestamp: entryTimestamp(entry),
				model: modelInfo,
				newReflections,
				promptUsed: promptFromReflectorResult(result),
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
				...(args.promptOverrides?.dropper !== undefined ? { systemPrompt: args.promptOverrides.dropper } : {}),
			});
			const droppedIds = result?.dropIds ?? [];
			dropObservations(state, droppedIds);
			currentEpoch.stages.push({
				type: "dropper",
				timestamp: entryTimestamp(entry),
				model: modelInfo,
				droppedIds,
				dropReasons: result?.dropReasons ?? {},
				promptUsed: promptFromDropperResult(result),
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
		survivingObservations: state.allObservations.filter((observation) =>
			!state.droppedObservationIds.has(observation.id) && !state.foldedObservationIds.has(observation.id)
		),
		survivingReflections: state.allReflections.filter((reflection) => !state.foldedReflectionIds.has(reflection.id)),
	};
}
