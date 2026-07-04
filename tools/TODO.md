# TODO

## bh command validation

bh has 10 commands. several slice the same run data differently:
overview, trace, passes, pipeline, drift — five formatters for one dataset.

before trimming: task 2-3 agents with inspecting sessions using all
commands and report which differentiators actually serve distinct
debugging/analysis workflows. then cut the ones that don't.

## efficiency metric

replay harness doesn't emit token counts. efficiency always ~0.

## reflector/dropper overrides

cockpit only exposes observer prompt overrides. harness supports all
three stages but cockpit CLI doesn't wire them yet.

## per-stage model override

all replay stages use the same model. configurable per-stage models
not exposed.

## session.json

sovereign's programmatic graph export spec. no consumer yet. if/when
agents need structured analysis, add to bh render.
