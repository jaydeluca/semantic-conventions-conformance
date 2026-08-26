# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

"""Joining a reduction to what the registry declared."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from conformance_report import _aggregate, discover
from conformance_report._aggregate import signal_coverage
from conftest import MODEL, write_target

EMPTY: dict[str, Any] = {
    "spans": {},
    "events": {},
    "metrics": {},
    "entities": {},
    "findings": [],
}


def coverage_of(data: dict[str, Any]) -> dict[str, Any]:
    return {s["name"]: s for s in signal_coverage(data, MODEL)}


def test_coverage_counts_each_level_separately() -> None:
    """A level is only comparable against itself, so each is its own tally."""
    signals = coverage_of(
        {**EMPTY, "spans": {"demo.client": ["demo.required", "demo.optional"]}}
    )
    assert signals["demo.client"]["coverage"] == {
        "conditionally_required_conditional": {"emitted": 0, "declared": 1},
        "opt_in": {"emitted": 1, "declared": 1},
        "recommended": {"emitted": 0, "declared": 1},
        "required": {"emitted": 1, "declared": 2},
    }


def test_missing_is_what_was_declared_and_did_not_arrive() -> None:
    signals = coverage_of(
        {**EMPTY, "spans": {"demo.client": ["demo.required"]}}
    )
    assert signals["demo.client"]["missing"] == [
        "demo.also_required",
        "demo.conditional",
        "demo.optional",
        "demo.recommended",
    ]


def test_an_attribute_outside_the_registry_is_not_counted() -> None:
    """The reduction already dropped it; the join must not resurrect it."""
    signals = coverage_of(
        {**EMPTY, "spans": {"demo.client": ["demo.required", "made.up"]}}
    )
    assert signals["demo.client"]["coverage"]["required"] == {
        "emitted": 1,
        "declared": 2,
    }


def test_a_signal_the_registry_does_not_declare_has_no_denominator() -> None:
    """Null, not zero: "unknown coverage" is not "no coverage"."""
    signals = coverage_of({**EMPTY, "spans": {"mystery.client": ["a"]}})
    assert signals["mystery.client"]["declared"] is None
    assert "coverage" not in signals["mystery.client"]


def test_spans_carry_the_identity_the_explorer_keys_on() -> None:
    """Span kind plus the attribute set, which is how it diffs telemetry."""
    signals = coverage_of(
        {**EMPTY, "spans": {"demo.client": ["demo.required"]}}
    )
    assert signals["demo.client"]["identity"] == {
        "span_kind": "client",
        "attributes": ["demo.required"],
    }


def test_a_metric_is_keyed_by_name_alone() -> None:
    signals = coverage_of({**EMPTY, "metrics": {"demo.duration": []}})
    assert "span_kind" not in signals["demo.duration"]["identity"]


def test_the_summary_sums_only_the_scored_levels() -> None:
    """Conditional and opt-in are reported, never scored. See the README."""
    signals = signal_coverage(
        {
            **EMPTY,
            "spans": {"demo.client": ["demo.required"]},
            "metrics": {"demo.duration": ["demo.recommended"]},
        },
        MODEL,
    )
    assert _aggregate._summary(signals) == {
        "required": {"emitted": 1, "declared": 3},
        "recommended": {"emitted": 1, "declared": 2},
    }


def test_the_registry_slice_holds_only_what_was_referenced() -> None:
    """The registries declare thousands of signals; these touch a handful."""
    referenced = _aggregate._referenced(
        MODEL, [{**EMPTY, "spans": {"demo.client": []}}]
    )
    assert list(referenced["spans"]) == ["demo.client"]
    assert referenced["metrics"] == {}
    assert referenced["events"] == {}


def test_rendering_is_stable(tmp_path: Path) -> None:
    """The file is committed and gated by git diff, so order cannot wobble."""
    document = {"b": [2, 1], "a": {"z": 1, "y": 2}}
    assert _aggregate.render(document) == _aggregate.render(dict(document))
    assert _aggregate.render(document).startswith('{\n  "a"')
    assert _aggregate.render(document).endswith("\n")


def test_rendering_carries_no_timestamp(checkout: Path) -> None:
    """A timestamp would make every rebuild a diff, breaking the CI gate."""
    text = _aggregate.render(
        {"schema_version": 1, "domains": {}, "registry": {}, "targets": []}
    )
    assert "time" not in text.lower()
    assert "date" not in text.lower()
    del checkout


def test_a_directory_with_no_reduction_is_not_a_target(tmp_path: Path) -> None:
    """Never run to completion is an absent measurement, not a failing one."""
    write_target(tmp_path, "demo/python/a/opentelemetry-a")
    unfinished = tmp_path / "scenarios" / "demo" / "python" / "b" / "otel-b"
    unfinished.mkdir(parents=True)
    (unfinished / "conformance.yaml").write_text(
        "runner: demo-conformance\ninstrumented_library: b\n"
        'instrumentation_library: otel-b\nscenarios:\n  main:\n    run: "true"\n',
        encoding="utf-8",
    )
    assert [t.id for t in discover(tmp_path)] == [
        "demo/python/a/opentelemetry-a"
    ]


def test_the_side_segment_is_recognised(tmp_path: Path) -> None:
    write_target(tmp_path, "http/java/okhttp/opentelemetry-javaagent/client")
    (target,) = discover(tmp_path)
    assert (target.domain, target.language, target.side) == (
        "http",
        "java",
        "client",
    )
    assert target.library == "okhttp"
    assert target.instrumentation == "opentelemetry-javaagent"


def test_a_trailing_segment_that_is_not_a_side_is_not_one(
    tmp_path: Path,
) -> None:
    """Only the two the HTTP domain splits on; anything else is a slug."""
    write_target(tmp_path, "demo/python/demo/opentelemetry-demo/extra")
    (target,) = discover(tmp_path)
    assert target.side is None


def test_a_layout_too_shallow_to_read_is_an_error(tmp_path: Path) -> None:
    write_target(tmp_path, "demo/python/demo")
    with pytest.raises(ValueError, match="domain"):
        discover(tmp_path)


def test_an_empty_checkout_says_so(tmp_path: Path) -> None:
    (tmp_path / "scenarios").mkdir()
    with pytest.raises(RuntimeError, match="no conformance directories"):
        _aggregate.build(tmp_path)


def test_findings_pass_through_verbatim(tmp_path: Path) -> None:
    """The report must not reinterpret a finding; weaver decided already."""
    finding = {
        "id": "unit_mismatch",
        "message": "Unit should be '{token}', but found 'token'.",
        "signal_type": "metric",
        "signal_name": "demo.duration",
        "context": {"expected": "{token}", "unit": "token"},
    }
    directory = write_target(
        tmp_path,
        "demo/python/demo/opentelemetry-demo",
        data={**EMPTY, "findings": [finding]},
    )
    assert json.loads((directory / "data.json").read_text())["findings"] == [
        finding
    ]
