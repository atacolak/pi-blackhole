/**
 * /replay command — replays the memory pipeline on a stored session with optional
 * prompt overrides. Outputs the replay result as JSON.
 *
 * Usage: /replay <jsonl-path> [--observer-prompt <text>] [--reflector-prompt <text>] [--dropper-prompt <text>]
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { replaySession } from "../replay.js";

export function registerReplayCommand(pi: ExtensionAPI): void {
	pi.registerCommand("replay", {
		description: "Replay the memory pipeline on a stored session JSONL. Args: <jsonl-path> [--observer-prompt <text>] [--reflector-prompt <text>] [--dropper-prompt <text>]",
		handler: async (args, ctx) => {
			const raw = typeof args === "string" ? args : "";
			const parts = raw.split(/\s+/);
			const jsonlPath = parts[0];

			if (!jsonlPath) {
				return { type: "text", text: "Usage: /replay <jsonl-path> [--observer-prompt <text>] [--reflector-prompt <text>] [--dropper-prompt <text>]" };
			}

			// Parse optional prompt overrides
			const promptOverrides: { observer?: string; reflector?: string; dropper?: string } = {};
			for (let i = 1; i < parts.length; i++) {
				if (parts[i] === "--observer-prompt" && i + 1 < parts.length) {
					promptOverrides.observer = parts[++i];
				} else if (parts[i] === "--reflector-prompt" && i + 1 < parts.length) {
					promptOverrides.reflector = parts[++i];
				} else if (parts[i] === "--dropper-prompt" && i + 1 < parts.length) {
					promptOverrides.dropper = parts[++i];
				}
			}

			try {
				// Resolve model and API key from the session context
				const model = ctx.model as any;
				const provider = model?.provider ?? "cpa";
				const modelId = model?.id ?? "gemini-3.1-flash-lite";

				// Get API key from the model registry
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				const apiKey = auth?.apiKey as string ?? "";

				ctx.ui?.notify(`Replay: starting on ${jsonlPath}...`, "info");

				const result = await replaySession({
					jsonlPath,
					model: { provider, id: modelId },
					apiKey,
					promptOverrides: Object.keys(promptOverrides).length > 0 ? promptOverrides : undefined,
					thinkingLevel: "low",
					maxTurns: 5,
				});

				// Build a summary
				const lines: string[] = [];
				lines.push("## replay result");
				lines.push(`- session: ${result.sessionSlug}`);
				lines.push(`- profile: ${result.profile}`);
				lines.push(`- epochs: ${result.epochs.length}`);
				lines.push(`- observations: ${result.allObservations.length} total, ${result.survivingObservations.length} surviving`);
				lines.push(`- reflections: ${result.allReflections.length} total, ${result.survivingReflections.length} surviving`);
				
				if (result.survivingObservations.length > 0) {
					lines.push("");
					lines.push("### surviving observations");
					for (const o of result.survivingObservations.slice(0, 20)) {
						lines.push(`- [${o.id.slice(0, 12)}] ${o.content.slice(0, 100)} (${o.relevance})`);
					}
					if (result.survivingObservations.length > 20) {
						lines.push(`- ... and ${result.survivingObservations.length - 20} more`);
					}
				}

				ctx.ui?.notify("Replay: complete", "info");

				return { type: "text", text: lines.join("\n") };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui?.notify(`Replay: failed — ${message}`, "error");
				return { type: "text", text: `replay failed: ${message}` };
			}
		},
	});
}
