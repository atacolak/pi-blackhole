# pi-blackhole prompt overrides — agent guide

## what this is

the pi-blackhole extension (cogito branch) now supports per-stage system prompt overrides. this lets you A/B test prompt variants on LIVE agents — no replay harness required. an agent loads pi-blackhole, you set `promptOverrides.observer` in its profile config, and every subsequent observer run uses your variant. reflector and dropper are also overrideable.

## config surface

in the agent's pi profile config (`unifiedConfig` or `config` section), add:

```json
{
  "om": {
    "promptOverrides": {
      "observer": "your custom observer system prompt text"
    },
    "promptVersions": {
      "observer": "v2-succinct",
      "reflector": "baseline",
      "dropper": "baseline"
    }
  }
}
```

`promptOverrides` — replaces the hardcoded system prompt for that stage. when absent or undefined, the default prompt is used. this is the functional seam.

`promptVersions` — metadata only. stored in run artifacts as provenance so you can trace which prompt produced which memory. not required for the override to work.

## how to test on a live agent

1. **spawn a scout (or whatever) with pi-blackhole enabled**
2. **give it a task that generates observations** — any multi-turn lookup or investigation task works
3. **inspect the artifacts** at `~/.pi/blackhole/runs/<session-id>/`
4. **compare** artifact quality between runs with different prompts

the override is *per agent session*. you don't need to restart anything. set the config key, start a new agent session, and the override is active.

## what changes

when `promptOverrides.observer` is set:
- the observer agent's system prompt is replaced entirely
- the hardcoded `OBSERVER_SYSTEM` constant is used only as fallback (when override is absent)
- the override is passed through `consolidation.ts` → `runObserver()` → `effectiveSystemPrompt`
- it appears in the run artifact's `prompt.system` field for traceability

same pattern for reflector and dropper stages.

## caveats

- **no hot-reload**: the override is read from config at agent startup. changing the config mid-session won't take effect until next session (or next compaction cycle — config is re-read each cycle).
- **prompt quality matters**: a bad override can silently degrade memory. always compare against baseline.
- **the default prompts live in**: `src/om/agents/observer/prompts.ts`, `src/om/agents/reflector/prompts.ts`, `src/om/agents/dropper/prompts.ts`
- **the seam lives in**: `src/om/consolidation.ts` → `stagePromptOverride()` function

## benchmarking workflow (live agent, no replay)

```
# 1. set baseline prompt in profile config (or leave override absent for default)
# 2. spawn agent, run a benchmark task
# 3. capture artifacts from ~/.pi/blackhole/runs/<session-id>/
# 4. change prompt override to variant
# 5. spawn a new agent session, run the SAME benchmark task
# 6. compare artifact quality, observation count, reflection depth
```

for A/B testing that requires many iterations, use the replay harness instead — it replays a single session's data through different prompts without needing to re-run the agent.

## files

| file | purpose |
|---|---|
| `src/core/unified-config.ts` | `promptVersions` and `promptOverrides` type definitions |
| `src/om/consolidation.ts` | `stagePromptOverride()` reads config, passes to agents |
| `src/om/agents/observer/agent.ts` | `systemPrompt?` param, falls to `OBSERVER_SYSTEM` |
| `src/om/agents/reflector/agent.ts` | same pattern |
| `src/om/agents/dropper/agent.ts` | same pattern |
