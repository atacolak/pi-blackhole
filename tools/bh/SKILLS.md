# bh — blackhole session forensics

## what it is

`bh` is a terminal CLI that correlates pi session JSONL files with their pi-blackhole pipeline artifacts (observer, reflector, dropper runs). it lets you inspect how the memory pipeline behaved: what was observed, what was reflected, what was dropped, what models were used, which prompt versions were active, and how compactions partitioned the session.

## where it lives

```
tools/pi-blackhole-benchmark/bh/
├── bh         ← shell wrapper (calls npx tsx bh.ts)
├── bh.ts      ← TypeScript source
└── SKILLS.md  ← you are here
```

it's symlinked to `~/workspace/bin/bh` for PATH access.

## how to invoke

```
bh <command> <session-id-or-path>
```

session can be a UUID (auto-discovered from `~/.pi/profiles/*/sessions/raw/`) or a direct path to a `.jsonl` file.

## commands

| command | what it does |
|---|---|
| `bh overview <s>` | one-shot session + pipeline summary |
| `bh trace <s>` | observation/reflection lifecycle across passes |
| `bh passes <s>` | pass-by-pass stats table |
| `bh pipeline <s>` | stage timing visualization (bar chart) |
| `bh drift <s>` | what got dropped, with content and relevance |
| `bh snapshot <s> <n>` | deep dive one pass: prompts, outputs, decisions, provenance |
| `bh gaps <s>` | anomalies: compactions, model changes, prompt overrides, unknown types |
| `bh provenance <s>` | prompt versions, hashes, and overrides per stage run |
| `bh epochs <s>` | compaction-bounded memory epochs with OM binning |
| `bh render <s>` | export to Obsidian vault markdown — observations, reflections, per-compaction epoch files, and session overview |

## typical agent workflow

### inspecting a session

```
bh overview 019f2670  # quick stats
bh epochs 019f2670    # how many compactions, what got folded per epoch
bh provenance 019f2670  # were prompt overrides active?
bh snapshot 019f2670 3  # deep dive pass 3
```

### checking for prompt override effects

```
bh provenance <session>  # shows if any stages used overrides, which prompt versions
bh gaps <session>        # section "prompt overrides active" if override detected
bh snapshot <session> 1  # per-stage lines show "v=v2-succinct override" marker
```

### comparing two prompt variants

run the same task through two agents with different `promptOverrides.observer`, then:
```
bh epochs <session-a>
bh epochs <session-b>
# compare obs counts, drop ratios, folded counts per epoch
```

## artifacts it reads

bh reads from:
- `~/.pi/profiles/<profile>/sessions/raw/*.jsonl` — session entries
- `~/.pi/blackhole/runs/<session-id>/*.json` — pipeline stage artifacts

## output format

all commands output ANSI-colored terminal text. colors:
- green: observations created
- cyan: reflections created
- red: observations dropped
- yellow: warnings (overrides, drift)
- dim: metadata, timestamps

## notes

- the pipeline artifacts must exist for most commands to be useful. if the agent didn't trigger compaction, artifacts may be absent or incomplete.
- `bh provenance` shows `[default]` for stages without overrides and `[OVERRIDE]` (yellow) when `prompt_override: true` is in the artifact.
- `bh epochs` bins OM entries by compaction boundaries. sessions without compactions show a single epoch.
