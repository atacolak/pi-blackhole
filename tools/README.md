# pi-blackhole benchmark

end-to-end memory pipeline evaluation using replay, probe generation, and judge scoring.

## what this is

a benchmark harness for the pi-blackhole observational memory pipeline. it replays session transcripts through variant pipeline configs, generates knowledge probes, scores memory quality, and exports results as an obsidian-navigable dashboard.

this implements the [GEPA](https://arxiv.org/pdf/2507.19457) (Genetic-Pareto) loop and [DSPy](https://dspy.ai)-style prompt optimization for the blackhole memory pipeline.

## architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      cockpit.py                              │
│  orchestrator: sessions × candidates → replay → judge        │
│  exports obsidian dashboard + per-run drill-down artifacts   │
└──────────────┬──────────────────────────┬───────────────────┘
               │                          │
     ┌─────────▼──────────┐    ┌─────────▼──────────┐
     │  replay harness     │    │  CPA proxy          │
     │  (pi-blackhole-dev) │    │  localhost:8317/v1  │
     │  replays observer/  │    │  probe gen + judge  │
     │  reflector/dropper  │    │  evaluation         │
     └─────────────────────┘    └─────────────────────┘
               │
     ┌─────────▼──────────┐
     │  session JSONL      │
     │  (input data)       │
     └─────────────────────┘
```

## file layout

```
pi-blackhole-benchmark/
├── README.md              ← you are here
├── cockpit/
│   └── cockpit.py         ← benchmark orchestrator (stdlib-only python)
├── exporter/
│   ├── export.py          ← session → obsidian markdown exporter
│   └── README.md          ← exporter documentation
├── prompts/
│   ├── observer_baseline.txt   ← default observer system prompt
│   └── observer_variant_a.txt  ← enhanced variant for A/B testing
├── sessions/              ← session JSONL fixtures for benchmarking
└── results/               ← benchmark run outputs
    └── run_NNN/
        ├── dashboard.md
        ├── probes/
        ├── session_1_<slug>/
        │   ├── session.md
        │   ├── observer_baseline/
        │   │   ├── surviving_memory.md
        │   │   ├── replay_summary.json
        │   │   └── probe_evaluations.json
        │   └── observer_variant_a/
        │       └── ...
        └── run_results.json
```

## prerequisites

- **node 22+** — for the replay bundle
- **python 3.10+** — for cockpit (stdlib only, no pip deps)
- **cpa proxy** running on `localhost:8317` — provides llm access
- **api key** for cpa proxy authentication
- **pi-blackhole-dev** — the replay harness bundle lives there

## quickstart

```bash
# 1. clone the benchmark repo
cd tools/
git clone <this-repo> pi-blackhole-benchmark

# 2. ensure the replay bundle exists
# (from pi-blackhole-dev, build if needed)
cd ../.pi/profiles/_shared/extensions/pi-blackhole-dev
npx esbuild src/replay_cli.ts --bundle --platform=node \
  --format=esm --outfile=dist/replay_bundle.mjs \
  --external:@earendil-works/* --external:typebox --external:openai

# 3. run a benchmark
cd tools/pi-blackhole-benchmark
python3 cockpit/cockpit.py run \
  --sessions path/to/session.jsonl \
  --candidates prompts/observer_baseline.txt prompts/observer_variant_a.txt \
  --replay-module ../../.pi/profiles/_shared/extensions/pi-blackhole-dev/dist/replay_bundle.mjs \
  --model '{"provider":"cpa","id":"gemini-3.1-flash-lite"}' \
  --api-key ata2003 \
  --output results/run_001

# 4. open in obsidian
# point obsidian vault to results/run_001/
# dashboard.md has wikilinks for drill-down navigation
```

## how it works

### replay harness (pi-blackhole-dev)

the replay harness replays a session through the blackhole consolidation pipeline:

1. **parse** — reads a session JSONL, identifies epoch boundaries (compactions)
2. **observer** — runs the observer agent on each source chunk, producing observations
3. **reflector** — runs the reflector agent on observations, crystallizing reflections
4. **dropper** — runs the dropper agent, pruning low-value observations
5. **surviving memory** — what remains after all dropper stages across all epochs

the harness supports `promptOverrides` to inject variant system prompts per stage, enabling A/B testing of observer/reflector/dropper prompts.

### cockpit

the cockpit orchestrates the full GEPA loop:

1. **generate** — for each session, generate 10 knowledge probes (questions + expected answers) from the full transcript
2. **evaluate** — for each (session × candidate) pair, replay the session with the candidate prompt, then judge whether the surviving memory can answer each probe
3. **analyze** — aggregate scores across 5 dimensions: retention, fidelity, entailment, safety, efficiency
4. **predict** — compare candidates; the better prompt earns higher fidelity + entailment scores

### dimensions

| dimension | what it measures |
|---|---|
| retention | fraction of observations that survive dropping |
| fidelity | probe answerability — can the memory answer factual questions? |
| entailment | can it answer questions requiring cross-referencing/temporal reasoning? |
| safety | are critical/high-priority observations retained? |
| efficiency | compression ratio — how much smaller is memory vs raw conversation? |

### exporter

the exporter renders a session JSONL into obsidian-compatible markdown:
- individual source entry files for native transclusion (`![[src/entry-NNNNN]]`)
- compaction epochs as structural boundaries
- pipeline stage timeline with observations, reflections, and drops
- session.json for programmatic graph analysis
- [`exporter/README.md`](exporter/README.md) has full details

## creating prompt variants

prompt variants are plain text files containing the full observer system prompt. the cockpit replaces the observer's system prompt with the candidate prompt during replay.

to create a variant:
1. copy `prompts/observer_baseline.txt`
2. modify observation rules, emphasis, or structure
3. run the benchmark comparing baseline vs variant

example variant strategies:
- **detail preservation**: emphasize file paths, error codes, exact values
- **temporal ordering**: number related observations for sequence reconstruction
- **cross-referencing**: explicitly link new observations to existing reflections
- **retention anchoring**: add justification for why high-priority facts matter

## extending

### adding sessions

drop session JSONL files into `sessions/`. the cockpit reads any JSONL with the standard pi session entry format.

### adding dimensions

edit `DIMENSIONS` in `cockpit.py`, update `calculate_metrics`, and add dimension weights to the probe generator prompt.

### using different models

the `--model` flag accepts arbitrary JSON model payloads:
```bash
--model '{"provider":"cpa","id":"gemini-3.1-flash-lite"}'
--model '{"provider":"cpa","id":"gemini-3.5-flash-low","api":"openai-completions","baseUrl":"http://localhost:8317/v1"}'
```

the replay harness auto-adds `api: "openai-completions"` and `baseUrl` if missing.

## known limitations

- **efficiency metric**: replay harness doesn't output token counts yet; efficiency is always ~0
- **observer-only**: cockpit only overrides observer prompts; reflector/dropper overrides exist in the harness but aren't wired to the cockpit CLI
- **single-model replay**: all stages use the same model; per-stage model override not exposed
- **cpa-only**: requires the cpa proxy; no direct provider support yet

## related repos

- `pi-blackhole` — the live extension (loaded by pi agents at runtime)
- `pi-blackhole-dev` — development clone with replay harness and prompt override support
- `blackhole-obsidian-exporter` — standalone exporter (copied into `exporter/`)
