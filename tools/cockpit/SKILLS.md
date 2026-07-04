# cockpit — pi-blackhole benchmark CLI

## what it is

cockpit orchestrates benchmarking of the pi-blackhole memory pipeline. it replays session data through variant prompts, generates knowledge probes, evaluates memory quality via CPA judge, and exports results. it implements the GEPA (Genetic-Pareto) loop: generate → evaluate → analyze → improve.

## where it lives

```
tools/pi-blackhole-benchmark/cockpit/
├── cockpit      ← shell wrapper (calls python3 cockpit.py)
├── cockpit.py   ← Python source
└── SKILLS.md    ← you are here
```

symlinked to `~/workspace/bin/cockpit` for PATH access.

## how to invoke

```
cockpit <command> [args...]
```

## commands

| command | what it does |
|---|---|
| `cockpit replay` | replay a session through one prompt variant |
| `cockpit eval` | generate probes + judge a replay run's memory |
| `cockpit compare` | side-by-side comparison of two eval runs |
| `cockpit bench` | full pipeline: replay + eval + compare + dashboard |

## typical A/B testing workflow

### step 1: replay with variant A

```
cockpit replay \
  --session sessions/scout.jsonl \
  --prompt prompts/observer_baseline.txt \
  --replay-module ../../.pi/profiles/_shared/pi-blackhole-replay/dist/replay_bundle.mjs \
  --model '{"provider":"cpa","id":"gemini-3.1-flash-lite"}' \
  --api-key ata2003 \
  --output results/variant_a
```

### step 2: replay with variant B

```
cockpit replay \
  --session sessions/scout.jsonl \
  --prompt prompts/observer_variant_a.txt \
  --replay-module ../../.pi/profiles/_shared/pi-blackhole-replay/dist/replay_bundle.mjs \
  --model '{"provider":"cpa","id":"gemini-3.1-flash-lite"}' \
  --api-key ata2003 \
  --output results/variant_b
```

### step 3: evaluate both

```
cockpit eval --replay-output results/variant_a --session sessions/scout.jsonl --api-key ata2003
cockpit eval --replay-output results/variant_b --session sessions/scout.jsonl --api-key ata2003
```

### step 4: compare

```
cockpit compare --run-a results/variant_a --run-b results/variant_b --label-a baseline --label-b variant
```

### shortcut: full bench (steps 1-4 in one command)

```
cockpit bench \
  --sessions sessions/scout.jsonl \
  --candidates prompts/observer_baseline.txt prompts/observer_variant_a.txt \
  --replay-module ../../.pi/profiles/_shared/pi-blackhole-replay/dist/replay_bundle.mjs \
  --model '{"provider":"cpa","id":"gemini-3.1-flash-lite"}' \
  --api-key ata2003 \
  --output results/bench_001
```

## evaluation dimensions

| dimension | what it measures |
|---|---|
| retention | fraction of observations that survive dropping |
| fidelity | probe answerability — can memory answer factual questions? |
| entailment | cross-referencing and temporal reasoning from memory |
| safety | are critical/high-priority observations retained? |
| efficiency | compression ratio — how much smaller is memory vs raw conversation? |

## prerequisites

- `node` 22+ — for the replay bundle
- `python` 3.10+ — for cockpit (stdlib only)
- CPA proxy running on `localhost:8317`
- replay bundle built (from pi-blackhole-replay worktree)
- API key (ata2003 for CPA)

## notes

- `cockpit eval` can use pre-generated probes (`--probes probes.json`) to skip the probe generation step. this lets you reuse probes across multiple prompt variants for fair comparison.
- `cockpit compare` loads `probe_evaluations.json` from each run directory. make sure `cockpit eval` was run first on both.
- the replay harness currently only overrides observer prompts. reflector/dropper overrides exist in the harness but aren't exposed via cockpit yet.
- efficiency metrics may report 0.0 if the replay harness doesn't output token counts (known limitation).
