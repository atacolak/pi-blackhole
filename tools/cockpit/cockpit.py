#!/usr/bin/env python3
"""blackhole-cockpit: replay orchestration, probe evaluation, and Obsidian output."""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

CPA_CHAT_COMPLETIONS_URL = "http://localhost:8317/v1/chat/completions"
DEFAULT_PROBE_MODEL = os.environ.get("COCKPIT_PROBE_MODEL", "gpt-5.4")
DEFAULT_JUDGE_MODEL = os.environ.get("COCKPIT_JUDGE_MODEL", "gemini-3.1-flash-lite")
DIMENSIONS = ["retention", "fidelity", "entailment", "safety", "efficiency"]


def slugify(value: str, default: str = "item") -> str:
    stem = Path(value).stem if value else default
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._-")
    return slug or default


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def parse_json_array(content: str) -> list[dict[str, Any]]:
    parsed = parse_json_value(content)
    if not isinstance(parsed, list):
        raise ValueError("LLM response did not contain a JSON array")
    return [item for item in parsed if isinstance(item, dict)]


def parse_json_object(content: str) -> dict[str, Any]:
    parsed = parse_json_value(content)
    if not isinstance(parsed, dict):
        raise ValueError("LLM response did not contain a JSON object")
    return parsed


def parse_json_value(content: str) -> Any:
    """Extract the first JSON object/array from plain or fenced LLM output."""
    text = content.strip()

    fence_match = re.search(r"```(?:json)?\s*(.*?)\s*```", text, flags=re.IGNORECASE | re.DOTALL)
    if fence_match:
        text = fence_match.group(1).strip()

    decoder = json.JSONDecoder()
    starts = [idx for idx, char in enumerate(text) if char in "[{" ]
    last_error: Exception | None = None
    for start in starts:
        try:
            value, _ = decoder.raw_decode(text[start:])
            return value
        except json.JSONDecodeError as exc:
            last_error = exc
    if last_error:
        raise ValueError(f"could not parse JSON from LLM response: {last_error}") from last_error
    raise ValueError("could not find JSON in LLM response")


def cpa_chat_completion(model: str, api_key: str, prompt: str, temperature: float, timeout: int = 120) -> str:
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": temperature,
    }
    request = urllib.request.Request(
        CPA_CHAT_COMPLETIONS_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace") if exc.fp else str(exc)
        raise RuntimeError(f"CPA request failed with HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"CPA request failed: {exc.reason}") from exc

    data = json.loads(body)
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"unexpected CPA response shape: {body[:500]}") from exc


def content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if isinstance(item.get("text"), str):
                    parts.append(item["text"])
                elif isinstance(item.get("content"), str):
                    parts.append(item["content"])
                else:
                    parts.append(json.dumps(item, ensure_ascii=False))
            else:
                parts.append(str(item))
        return "\n".join(part for part in parts if part)
    if isinstance(content, dict):
        for key in ("text", "content", "value"):
            if isinstance(content.get(key), str):
                return content[key]
        return json.dumps(content, ensure_ascii=False)
    return str(content)


def iter_message_entries(obj: Any) -> Iterable[tuple[str, str]]:
    """Yield user/assistant messages from common JSONL session event shapes."""
    if not isinstance(obj, dict):
        return

    role = obj.get("role")
    if role in {"user", "assistant"} and "content" in obj:
        text = content_to_text(obj.get("content"))
        if text:
            yield role, text
        return

    for key in ("message", "entry", "event", "data"):
        child = obj.get(key)
        if isinstance(child, dict):
            child_role = child.get("role")
            if child_role in {"user", "assistant"} and "content" in child:
                text = content_to_text(child.get("content"))
                if text:
                    yield child_role, text
                return

    for value in obj.values():
        if isinstance(value, dict):
            yield from iter_message_entries(value)
        elif isinstance(value, list):
            for item in value:
                yield from iter_message_entries(item)


def transcript_from_jsonl(session_path: Path) -> str:
    parts: list[str] = []
    with session_path.open("r", encoding="utf-8", errors="replace") as handle:
        for line_number, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                event = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            for role, text in iter_message_entries(event):
                parts.append(f"{role.upper()}:\n{text}")
    return "\n\n".join(parts)


def generate_probes(transcript: str, model: str, api_key: str) -> list[dict[str, Any]]:
    prompt = """You are generating test questions to evaluate a memory system.

Below is the full transcript of a coding session. Generate 10 questions that test whether someone can recall and reason about the session's content using ONLY summarized memory (not the full transcript).

Requirements for each question:
- It must be answerable from the transcript
- It must require factual recall, cross-referencing, or temporal reasoning — not just "what was discussed"
- Mix of question types: specific facts, file paths, decisions made, error messages, tool outputs, sequence of events
- Each question should be answerable in 1-3 sentences

Return a JSON array of objects with fields: "id" (string like "q01"), "question" (string), "expected_answer" (string, the correct answer from the transcript), "dimension" (one of: "retention", "fidelity", "entailment", "safety", "efficiency").

TRANSCRIPT:
""" + transcript[:80000]

    content = cpa_chat_completion(model=model, api_key=api_key, prompt=prompt, temperature=0.3, timeout=120)
    probes = parse_json_array(content)
    return normalize_probes(probes)


def normalize_probes(probes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for index, probe in enumerate(probes, start=1):
        question = str(probe.get("question", "")).strip()
        expected = str(probe.get("expected_answer", probe.get("expected", ""))).strip()
        if not question:
            continue
        dimension = str(probe.get("dimension", "fidelity")).strip().lower()
        if dimension not in DIMENSIONS:
            dimension = "fidelity"
        normalized.append(
            {
                "id": str(probe.get("id") or f"q{index:02d}"),
                "question": question,
                "expected_answer": expected,
                "dimension": dimension,
            }
        )
    return normalized


def evaluate_probe(question: str, expected: str, surviving_memory: str, model: str, api_key: str) -> dict[str, Any]:
    prompt = f"""You are evaluating a memory system. You are given:
1. A question about a past coding session
2. The expected correct answer
3. The memory system's surviving observations and reflections (summarized memory)

Determine if the question can be answered correctly using ONLY the provided memory. Score 0-5:
- 5: fully answered, matches expected
- 4: mostly answered, minor omissions
- 3: partially answered, key facts present but incomplete
- 2: marginally answered, only tangential facts
- 1: barely answered, mostly wrong or missing
- 0: cannot be answered from the provided memory

Return JSON: {{"score": <0-5>, "explanation": "<why>", "answerable": true/false}}

QUESTION: {question}
EXPECTED ANSWER: {expected}

MEMORY SYSTEM OUTPUT:
{surviving_memory}"""

    content = cpa_chat_completion(model=model, api_key=api_key, prompt=prompt, temperature=0.0, timeout=120)
    result = parse_json_object(content)
    try:
        score = float(result.get("score", 0))
    except (TypeError, ValueError):
        score = 0.0
    result["score"] = max(0.0, min(5.0, score))
    result["answerable"] = bool(result.get("answerable", result["score"] > 0))
    result["explanation"] = str(result.get("explanation", ""))
    return result


def run_replay(session_path: Path, candidate_prompt: str, replay_module: Path, model_payload: dict[str, Any], api_key: str) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    # Ensure model_payload has the right provider config for CPA proxy
    if "api" not in model_payload:
        model_payload["api"] = "openai-completions"
    if "baseUrl" not in model_payload:
        model_payload["baseUrl"] = "http://localhost:8317/v1"

    payload = {
        "jsonlPath": str(session_path),
        "model": model_payload,
        "apiKey": api_key,
        "promptOverrides": {"observer": candidate_prompt},
        "thinkingLevel": "low",
        "maxTurns": 5,
    }
    try:
        # Use the esbuild bundle (pre-compiled) instead of npx tsx
        completed = subprocess.run(
            ["node", str(replay_module)],
            input=json.dumps(payload),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=None,
            check=False,
            cwd=str(replay_module.parent),
        )
    except OSError as exc:
        return None, {"message": f"failed to start replay harness: {exc}"}

    if completed.returncode != 0:
        return None, {
            "message": f"replay harness exited with code {completed.returncode}",
            "stdout": completed.stdout[-2000:] if completed.stdout else "",
            "stderr": completed.stderr[-2000:] if completed.stderr else "",
        }

    # Extract JSON result from stdout (LLM streaming may produce other output)
    result_text = completed.stdout
    if result_text:
        for line in reversed(result_text.split("\n")):
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                try:
                    return json.loads(line), None
                except json.JSONDecodeError:
                    pass
    return None, {
        "message": "replay harness returned no parseable JSON",
        "stdout": completed.stdout[-2000:] if completed.stdout else "",
        "stderr": completed.stderr[-2000:] if completed.stderr else "",
    }


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def replay_list(result: dict[str, Any], *keys: str) -> list[Any]:
    for key in keys:
        value = result.get(key)
        if isinstance(value, list):
            return value
    return []


def item_id(item: Any, fallback_prefix: str, index: int) -> str:
    if isinstance(item, dict):
        for key in ("id", "observationId", "reflectionId", "uuid"):
            value = item.get(key)
            if value is not None:
                return str(value)
    return f"{fallback_prefix}{index:03d}"


def item_content(item: Any) -> str:
    if isinstance(item, str):
        return item
    if isinstance(item, dict):
        for key in ("content", "text", "summary", "message", "body"):
            value = item.get(key)
            if value is not None:
                return content_to_text(value)
        return json.dumps(item, ensure_ascii=False, sort_keys=True)
    return str(item)


def item_priority(item: Any) -> str:
    if isinstance(item, dict):
        for key in ("priority", "importance", "severity", "level"):
            value = item.get(key)
            if value is not None:
                return str(value).lower()
    return ""


def serialize_surviving_memory(result: dict[str, Any]) -> str:
    observations = replay_list(result, "survivingObservations", "surviving_observations")
    reflections = replay_list(result, "survivingReflections", "surviving_reflections")
    lines: list[str] = ["OBSERVATIONS:"]
    for index, obs in enumerate(observations, start=1):
        lines.append(f"[{item_id(obs, 'obs_', index)}] {item_content(obs)}")
    lines.append("")
    lines.append("REFLECTIONS:")
    for index, ref in enumerate(reflections, start=1):
        lines.append(f"[{item_id(ref, 'ref_', index)}] {item_content(ref)}")
    return "\n".join(lines).rstrip() + "\n"


def estimate_tokens(text: str) -> int:
    # Cheap, deterministic approximation; adequate for comparing replay outputs.
    return max(1, (len(text) + 3) // 4) if text else 0


def replay_token_count(result: dict[str, Any], key: str, fallback_text: str = "") -> int:
    value = result.get(key)
    if isinstance(value, (int, float)):
        return int(value)
    if fallback_text:
        return estimate_tokens(fallback_text)
    return 0


def observation_key(item: Any, index: int) -> str:
    if isinstance(item, dict):
        for key in ("id", "observationId", "uuid"):
            value = item.get(key)
            if value is not None:
                return str(value)
    return item_content(item)[:200] or f"index:{index}"


def calculate_metrics(result: dict[str, Any] | None, probes: list[dict[str, Any]], evaluations: list[dict[str, Any]], replay_error: dict[str, Any] | None) -> dict[str, float]:
    if result is None or replay_error is not None:
        return {dimension: 0.0 for dimension in DIMENSIONS}

    all_observations = replay_list(result, "allObservations", "observations", "all_observations")
    surviving_observations = replay_list(result, "survivingObservations", "surviving_observations")

    retention = 1.0 if not all_observations else len(surviving_observations) / len(all_observations)

    probe_scores = [float(evaluation.get("score", 0.0)) / 5.0 for evaluation in evaluations]
    fidelity = sum(probe_scores) / len(probe_scores) if probe_scores else 0.0

    entailment_scores = [
        float(evaluation.get("score", 0.0)) / 5.0
        for probe, evaluation in zip(probes, evaluations)
        if probe.get("dimension") == "entailment"
    ]
    entailment = sum(entailment_scores) / len(entailment_scores) if entailment_scores else fidelity

    critical_high = [obs for obs in all_observations if item_priority(obs) in {"critical", "high"}]
    if critical_high:
        surviving_keys = {observation_key(obs, index) for index, obs in enumerate(surviving_observations)}
        retained = sum(1 for index, obs in enumerate(critical_high) if observation_key(obs, index) in surviving_keys)
        safety = retained / len(critical_high)
    else:
        safety = 1.0

    surviving_memory = serialize_surviving_memory(result)
    surviving_tokens = replay_token_count(result, "survivingTokenCount", surviving_memory)
    total_tokens = replay_token_count(result, "totalTokenCount")
    if total_tokens <= 0:
        total_tokens = replay_token_count(result, "totalTokens")
    if total_tokens <= 0:
        all_text = "\n".join(item_content(obs) for obs in all_observations)
        total_tokens = estimate_tokens(all_text)
    efficiency = 1.0 if total_tokens <= 0 else 1.0 - min(1.0, surviving_tokens / total_tokens)

    return {
        "retention": clamp01(retention),
        "fidelity": clamp01(fidelity),
        "entailment": clamp01(entailment),
        "safety": clamp01(safety),
        "efficiency": clamp01(efficiency),
    }


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def metrics_avg(metrics: dict[str, float]) -> float:
    return sum(metrics.get(dimension, 0.0) for dimension in DIMENSIONS) / len(DIMENSIONS)


def aggregate_metrics(rows: list[dict[str, Any]]) -> dict[str, float]:
    if not rows:
        return {dimension: 0.0 for dimension in DIMENSIONS}
    return {
        dimension: sum(float(row["metrics"].get(dimension, 0.0)) for row in rows) / len(rows)
        for dimension in DIMENSIONS
    }


def markdown_score_row(label: str, metrics: dict[str, float]) -> str:
    values = [f"{metrics.get(dimension, 0.0):.2f}" for dimension in DIMENSIONS]
    return f"| {label} | " + " | ".join(values) + f" | {metrics_avg(metrics):.2f} |"


def write_run_artifacts(run_dir: Path, replay_result: dict[str, Any] | None, replay_error: dict[str, Any] | None, surviving_memory: str, probes: list[dict[str, Any]], evaluations: list[dict[str, Any]], metrics: dict[str, float]) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    write_json(run_dir / "replay_summary.json", replay_result if replay_result is not None else {"error": replay_error})
    (run_dir / "surviving_memory.md").write_text(surviving_memory, encoding="utf-8")
    write_json(run_dir / "probe_evaluations.json", {"probes": probes, "evaluations": evaluations, "metrics": metrics})


def write_session_index(session_dir: Path, session_label: str, rows: list[dict[str, Any]]) -> None:
    lines = [f"# {session_label}", ""]
    lines.append("| candidate | retention | fidelity | entailment | safety | efficiency | avg | drill-down |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for row in rows:
        metrics = row["metrics"]
        values = [f"{metrics.get(dimension, 0.0):.2f}" for dimension in DIMENSIONS]
        rel = Path(row["run_dir"]).name
        lines.append(f"| {row['candidate_label']} | " + " | ".join(values) + f" | {metrics_avg(metrics):.2f} | [[{rel}/surviving_memory.md]] |")
    lines.append("")
    (session_dir / "session.md").write_text("\n".join(lines), encoding="utf-8")


def write_dashboard(output_dir: Path, run_id: str, sessions: list[Path], candidates: list[Path], rows: list[dict[str, Any]]) -> None:
    rows_by_candidate: dict[str, list[dict[str, Any]]] = defaultdict(list)
    rows_by_session: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        rows_by_candidate[row["candidate_slug"]].append(row)
        rows_by_session[row["session_slug"]].append(row)

    lines: list[str] = ["---", f"run_id: {run_id}", f"sessions: {len(sessions)}", f"candidates: {len(candidates)}", "---", "", "## scorecard", ""]
    lines.append("| candidate | retention | fidelity | entailment | safety | efficiency | avg |")
    lines.append("|---|---|---|---|---|---|---|")
    for candidate in candidates:
        candidate_slug = slugify(str(candidate), "candidate")
        candidate_rows = rows_by_candidate.get(candidate_slug, [])
        label = candidate_slug
        metrics = aggregate_metrics(candidate_rows)
        lines.append(markdown_score_row(label, metrics))

    lines.extend(["", "## per-session breakdown", ""])
    for index, session in enumerate(sessions, start=1):
        session_slug = slugify(str(session), f"session_{index}")
        session_dir_name = f"session_{index}_{session_slug}"
        session_rows = rows_by_session.get(session_slug, [])
        lines.append(f"### session {index}: {session_slug}")
        lines.append(f"[[{session_dir_name}/session.md]]")
        lines.append("")
        lines.append("| candidate | retention | fidelity | entailment | safety | efficiency | avg | drill-down |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for row in session_rows:
            metrics = row["metrics"]
            values = [f"{metrics.get(dimension, 0.0):.2f}" for dimension in DIMENSIONS]
            rel_run = f"{session_dir_name}/{Path(row['run_dir']).name}"
            lines.append(f"| {row['candidate_label']} | " + " | ".join(values) + f" | {metrics_avg(metrics):.2f} | [[{rel_run}/surviving_memory.md]] |")
        lines.append("")

    (output_dir / "dashboard.md").write_text("\n".join(lines), encoding="utf-8")


def load_or_generate_probes(session_path: Path, probe_path: Path, api_key: str) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    if probe_path.exists():
        try:
            data = json.loads(read_text(probe_path))
            if isinstance(data, list):
                return normalize_probes(data), None
            return [], {"message": f"probe cache is not a JSON array: {probe_path}"}
        except (OSError, json.JSONDecodeError) as exc:
            return [], {"message": f"failed to read probe cache {probe_path}: {exc}"}

    try:
        transcript = transcript_from_jsonl(session_path)
        probes = generate_probes(transcript, DEFAULT_PROBE_MODEL, api_key)
    except Exception as exc:  # LLM/caching failure should not kill the benchmark structure.
        return [], {"message": f"probe generation failed: {exc}"}

    write_json(probe_path, probes)
    return probes, None


def evaluate_probes(probes: list[dict[str, Any]], surviving_memory: str, api_key: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    evaluations: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for probe in probes:
        try:
            evaluation = evaluate_probe(
                question=str(probe.get("question", "")),
                expected=str(probe.get("expected_answer", "")),
                surviving_memory=surviving_memory,
                model=DEFAULT_JUDGE_MODEL,
                api_key=api_key,
            )
        except Exception as exc:
            evaluation = {"score": 0.0, "explanation": f"judge failed: {exc}", "answerable": False}
            errors.append({"probe_id": probe.get("id"), "message": str(exc)})
        evaluations.append(evaluation)
    return evaluations, errors


def run_command(args: argparse.Namespace) -> int:
    """bench: full pipeline — replay + eval + compare + dashboard."""
    output_dir = Path(args.output).expanduser().resolve()
    probes_dir = output_dir / "probes"
    output_dir.mkdir(parents=True, exist_ok=True)
    probes_dir.mkdir(parents=True, exist_ok=True)

    sessions = [Path(path).expanduser().resolve() for path in args.sessions]
    candidates = [Path(path).expanduser().resolve() for path in args.candidates]
    replay_module = Path(args.replay_module).expanduser().resolve()

    try:
        model_payload = json.loads(args.model)
        if not isinstance(model_payload, dict):
            raise ValueError("--model must decode to a JSON object")
    except (json.JSONDecodeError, ValueError) as exc:
        print(f"error: invalid --model JSON: {exc}", file=sys.stderr)
        return 2

    run_id = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    rows: list[dict[str, Any]] = []
    probe_errors: dict[str, Any] = {}

    for session_index, session_path in enumerate(sessions, start=1):
        session_slug = slugify(str(session_path), f"session_{session_index}")
        session_dir = output_dir / f"session_{session_index}_{session_slug}"
        session_dir.mkdir(parents=True, exist_ok=True)

        probe_path = probes_dir / f"{session_slug}.json"
        probes, probe_error = load_or_generate_probes(session_path, probe_path, args.api_key)
        if probe_error:
            probe_errors[session_slug] = probe_error
            write_json(probes_dir / f"{session_slug}.error.json", probe_error)
            print(f"warning: {probe_error['message']}", file=sys.stderr)

        session_rows: list[dict[str, Any]] = []
        for candidate_index, candidate_path in enumerate(candidates, start=1):
            candidate_slug = slugify(str(candidate_path), f"candidate_{candidate_index}")
            candidate_label = candidate_slug
            try:
                candidate_prompt = read_text(candidate_path)
            except OSError as exc:
                replay_result = None
                replay_error = {"message": f"failed to read candidate prompt: {exc}"}
            else:
                replay_result, replay_error = run_replay(session_path, candidate_prompt, replay_module, model_payload, args.api_key)

            if replay_error:
                print(f"warning: {session_slug}/{candidate_slug}: {replay_error['message']}", file=sys.stderr)

            surviving_memory = serialize_surviving_memory(replay_result) if replay_result is not None else "OBSERVATIONS:\n\nREFLECTIONS:\n"
            evaluations, judge_errors = evaluate_probes(probes, surviving_memory, args.api_key) if probes else ([], [])
            metrics = calculate_metrics(replay_result, probes, evaluations, replay_error)
            run_dir = session_dir / candidate_slug
            write_run_artifacts(run_dir, replay_result, replay_error, surviving_memory, probes, evaluations, metrics)
            if replay_error:
                write_json(run_dir / "replay_error.json", replay_error)
            if judge_errors:
                write_json(run_dir / "judge_errors.json", judge_errors)

            row = {
                "session_slug": session_slug,
                "session_label": session_slug,
                "candidate_slug": candidate_slug,
                "candidate_label": candidate_label,
                "metrics": metrics,
                "run_dir": str(run_dir),
                "replay_error": replay_error,
            }
            rows.append(row)
            session_rows.append(row)

        write_session_index(session_dir, session_slug, session_rows)

    if probe_errors:
        write_json(output_dir / "probe_errors.json", probe_errors)
    write_json(output_dir / "run_results.json", {"run_id": run_id, "rows": rows})
    write_dashboard(output_dir, run_id, sessions, candidates, rows)
    print(f"dashboard: {output_dir / 'dashboard.md'}")
    return 0


def replay_command(args: argparse.Namespace) -> int:
    """replay: run a session through one prompt variant via the replay harness."""
    session_path = Path(args.session).expanduser().resolve()
    candidate_path = Path(args.prompt).expanduser().resolve()
    replay_module = Path(args.replay_module).expanduser().resolve()
    output_dir = Path(args.output).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        model_payload = json.loads(args.model)
        if not isinstance(model_payload, dict):
            raise ValueError("--model must decode to a JSON object")
    except (json.JSONDecodeError, ValueError) as exc:
        print(f"error: invalid --model JSON: {exc}", file=sys.stderr)
        return 2

    try:
        candidate_prompt = read_text(candidate_path)
    except OSError as exc:
        print(f"error: failed to read prompt file: {exc}", file=sys.stderr)
        return 1

    replay_result, replay_error = run_replay(session_path, candidate_prompt, replay_module, model_payload, args.api_key)

    if replay_error:
        print(f"error: {replay_error['message']}", file=sys.stderr)
        write_json(output_dir / "replay_error.json", replay_error)
        return 1

    surviving_memory = serialize_surviving_memory(replay_result) if replay_result else ""
    write_json(output_dir / "replay_result.json", replay_result)
    (output_dir / "surviving_memory.md").write_text(surviving_memory, encoding="utf-8")
    print(f"replay complete: {output_dir}")
    print(f"  surviving observations: {len(replay_list(replay_result, 'survivingObservations', 'surviving_observations'))}")
    print(f"  surviving reflections: {len(replay_list(replay_result, 'survivingReflections', 'surviving_reflections'))}")
    return 0


def eval_command(args: argparse.Namespace) -> int:
    """eval: generate probes and judge a replay run's surviving memory."""
    run_dir = Path(args.replay_output).expanduser().resolve()
    if not run_dir.is_dir():
        print(f"error: replay output dir not found: {run_dir}", file=sys.stderr)
        return 1

    replay_path = run_dir / "replay_result.json"
    if not replay_path.exists():
        print(f"error: replay_result.json not found in {run_dir}", file=sys.stderr)
        return 1

    try:
        replay_result = json.loads(read_text(replay_path))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: failed to read replay result: {exc}", file=sys.stderr)
        return 1

    # find the session path from the replay result or args
    session_path = None
    if args.session:
        session_path = Path(args.session).expanduser().resolve()

    probes: list[dict[str, Any]] = []
    if args.probes:
        probe_path = Path(args.probes).expanduser().resolve()
        probes, probe_error = load_or_generate_probes(session_path or probe_path, probe_path, args.api_key)
        if probe_error:
            print(f"warning: {probe_error['message']}", file=sys.stderr)
    elif session_path:
        probe_path = run_dir / "probes.json"
        probes, probe_error = load_or_generate_probes(session_path, probe_path, args.api_key)
        if probe_error:
            print(f"warning: {probe_error['message']}", file=sys.stderr)
    else:
        print("error: --session or --probes required for probe generation", file=sys.stderr)
        return 1

    if not probes:
        print("error: no probes generated or loaded", file=sys.stderr)
        return 1

    surviving_memory = serialize_surviving_memory(replay_result)
    evaluations, judge_errors = evaluate_probes(probes, surviving_memory, args.api_key)
    metrics = calculate_metrics(replay_result, probes, evaluations, None)

    write_json(run_dir / "probes.json", probes)
    write_json(run_dir / "probe_evaluations.json", {"probes": probes, "evaluations": evaluations, "metrics": metrics})
    if judge_errors:
        write_json(run_dir / "judge_errors.json", judge_errors)
        print(f"  judge errors: {len(judge_errors)}", file=sys.stderr)

    print(f"eval complete: {run_dir}")
    print(f"  probes: {len(probes)}")
    for dim in DIMENSIONS:
        print(f"  {dim}: {metrics.get(dim, 0.0):.3f}")
    print(f"  avg: {metrics_avg(metrics):.3f}")
    return 0


def compare_command(args: argparse.Namespace) -> int:
    """compare: side-by-side comparison of two eval runs."""
    run_a = Path(args.run_a).expanduser().resolve()
    run_b = Path(args.run_b).expanduser().resolve()

    def load_eval_metrics(run: Path) -> tuple[dict[str, float], str]:
        eval_path = run / "probe_evaluations.json"
        if not eval_path.exists():
            return {d: 0.0 for d in DIMENSIONS}, f"(no eval data: {eval_path})"
        try:
            data = json.loads(read_text(eval_path))
            metrics = data.get("metrics", {})
            return {d: float(metrics.get(d, 0.0)) for d in DIMENSIONS}, ""
        except (OSError, json.JSONDecodeError) as exc:
            return {d: 0.0 for d in DIMENSIONS}, f"(parse error: {exc})"

    metrics_a, err_a = load_eval_metrics(run_a)
    metrics_b, err_b = load_eval_metrics(run_b)

    label_a = args.label_a or run_a.name
    label_b = args.label_b or run_b.name

    print(f"\n{'dimension':<14} {label_a:>8} {label_b:>8} {'delta':>8} {'winner':>8}")
    print("-" * 52)

    winners: dict[str, str] = {}
    for dim in DIMENSIONS:
        a = metrics_a.get(dim, 0.0)
        b = metrics_b.get(dim, 0.0)
        delta = b - a
        winner = "B" if delta > 0.005 else "A" if delta < -0.005 else "tie"
        winners[dim] = winner
        delta_str = f"{delta:+.3f}"
        print(f"{dim:<14} {a:>8.3f} {b:>8.3f} {delta_str:>8} {winner:>8}")

    a_avg = metrics_avg(metrics_a)
    b_avg = metrics_avg(metrics_b)
    delta_avg = b_avg - a_avg
    print("-" * 52)
    print(f"{'avg':<14} {a_avg:>8.3f} {b_avg:>8.3f} {delta_avg:>+8.3f} {'B' if delta_avg > 0 else 'A' if delta_avg < 0 else 'tie':>8}")

    win_count = sum(1 for w in winners.values() if w == "B")
    loss_count = sum(1 for w in winners.values() if w == "A")
    print(f"\nB wins {win_count}/{len(DIMENSIONS)} dimensions" + (f" (warning: {err_a} {err_b})" if err_a or err_b else ""))

    if err_a:
        print(f"  A: {err_a}")
    if err_b:
        print(f"  B: {err_b}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="blackhole-cockpit: replay orchestration, probe evaluation, and benchmark dashboard.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # replay — single session through one prompt variant
    replay_p = subparsers.add_parser("replay", help="replay a session through one prompt variant")
    replay_p.add_argument("--session", required=True, help="session JSONL file")
    replay_p.add_argument("--prompt", required=True, help="candidate prompt file")
    replay_p.add_argument("--replay-module", required=True, help="path to replay bundle (dist/replay_bundle.mjs)")
    replay_p.add_argument("--model", required=True, help="JSON model payload for the replay harness")
    replay_p.add_argument("--api-key", required=True, help="API key for replay harness and CPA proxy")
    replay_p.add_argument("--output", required=True, help="output directory for replay artifacts")
    replay_p.set_defaults(func=replay_command)

    # eval — generate probes and judge a replay run
    eval_p = subparsers.add_parser("eval", help="generate probes and evaluate a replay run")
    eval_p.add_argument("--replay-output", required=True, help="directory containing replay_result.json")
    eval_p.add_argument("--session", default=None, help="session JSONL for probe generation (optional if --probes given)")
    eval_p.add_argument("--probes", default=None, help="pre-generated probes JSON file (skips probe generation)")
    eval_p.add_argument("--api-key", required=True, help="API key for CPA proxy")
    eval_p.set_defaults(func=eval_command)

    # compare — side-by-side comparison of two eval runs
    compare_p = subparsers.add_parser("compare", help="compare two eval runs side by side")
    compare_p.add_argument("--run-a", required=True, help="first eval run directory")
    compare_p.add_argument("--run-b", required=True, help="second eval run directory")
    compare_p.add_argument("--label-a", default=None, help="label for run A (default: directory name)")
    compare_p.add_argument("--label-b", default=None, help="label for run B (default: directory name)")
    compare_p.set_defaults(func=compare_command)

    # bench — full pipeline: sessions × candidates → dashboard
    bench_p = subparsers.add_parser("bench", help="full pipeline: replay + eval + compare + dashboard")
    bench_p.add_argument("--sessions", nargs="+", required=True, help="session JSONL files")
    bench_p.add_argument("--candidates", nargs="+", required=True, help="candidate observer prompt files")
    bench_p.add_argument("--replay-module", required=True, help="path to replay bundle (dist/replay_bundle.mjs)")
    bench_p.add_argument("--model", required=True, help="JSON model payload for the replay harness")
    bench_p.add_argument("--api-key", required=True, help="API key for replay harness and CPA proxy")
    bench_p.add_argument("--output", required=True, help="output directory for probes, runs, and dashboard")
    bench_p.set_defaults(func=run_command)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
