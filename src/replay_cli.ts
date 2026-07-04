#!/usr/bin/env node
/**
 * Standalone replay CLI entry point.
 * Reads ReplayArgs JSON from stdin, writes ReplayResult JSON to stdout.
 *
 * Usage: echo '{...}' | node replay_bundle.mjs > result.json
 */
import { replaySession } from "./replay.js";
import { createInterface } from "node:readline";

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
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

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error("replay error:", message);
	process.exit(1);
});
