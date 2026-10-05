# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

"""Tests for report generation, freshness checks and Markdown summaries."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from conformance_report import _aggregate, _cli, _markdown
from conftest import write_target

TARGET = "demo/python/demo/opentelemetry-demo"

# Every verb here builds, and building resolves a `runner:`.
pytestmark = pytest.mark.usefixtures("one_domain")


def build_into(root: Path) -> Path:
    assert _cli.cli(["--root", str(root), "build"]) == 0
    return root / _cli.DEFAULT_REPORT


def test_build_writes_the_report_where_the_site_reads_it(
    tmp_path: Path,
) -> None:
    write_target(tmp_path, TARGET)
    report = build_into(tmp_path)
    assert report.exists()
    document: dict[str, Any] = json.loads(report.read_text())
    assert document["schema_version"] == _aggregate.SCHEMA_VERSION
    assert [t["id"] for t in document["targets"]] == [TARGET]


def test_build_is_byte_identical_twice_over(tmp_path: Path) -> None:
    """`check` is a byte comparison, so this is what makes it usable."""
    write_target(tmp_path, TARGET)
    first = build_into(tmp_path).read_bytes()
    second = build_into(tmp_path).read_bytes()
    assert first == second


def test_check_passes_on_a_report_that_is_current(tmp_path: Path) -> None:
    write_target(tmp_path, TARGET)
    build_into(tmp_path)
    assert _cli.cli(["--root", str(tmp_path), "check"]) == 0


def test_check_fails_when_a_reduction_moved(tmp_path: Path) -> None:
    """The same shape as the repo's existing data.json freshness gate."""
    write_target(tmp_path, TARGET)
    build_into(tmp_path)
    write_target(
        tmp_path,
        TARGET,
        data={
            "spans": {"demo.client": ["demo.required"]},
            "events": {},
            "metrics": {},
            "entities": {},
            "findings": [],
        },
    )
    assert _cli.cli(["--root", str(tmp_path), "check"]) == 1


def test_check_fails_when_the_report_was_never_built(tmp_path: Path) -> None:
    write_target(tmp_path, TARGET)
    assert _cli.cli(["--root", str(tmp_path), "check"]) == 1


def test_check_fails_when_a_target_is_added(tmp_path: Path) -> None:
    """A new scenario has to be published, not silently left off the site."""
    write_target(tmp_path, TARGET)
    build_into(tmp_path)
    write_target(tmp_path, "demo/python/other/opentelemetry-other")
    assert _cli.cli(["--root", str(tmp_path), "check"]) == 1


def test_markdown_says_what_the_run_covered(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_target(tmp_path, TARGET)
    assert _cli.cli(["--root", str(tmp_path), "markdown"]) == 0
    printed = capsys.readouterr().out
    assert "Semantic-convention conformance" in printed
    assert "1 target, 0 findings." in printed
    assert "gzipped" in printed
    assert "open-telemetry/demo @ `v1.0.0` (`demo-conformance`)" in printed
    assert "Conformance changes" not in printed


def test_markdown_against_a_previous_report_says_what_moved(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_target(tmp_path, TARGET)
    report = build_into(tmp_path)
    against = ["markdown", "--against", str(report)]
    assert _cli.cli(["--root", str(tmp_path), *against]) == 0
    printed = capsys.readouterr().out
    assert "1 target, 0 findings (+0)." in printed
    assert "gzipped (+0 B)" in printed
    assert printed.endswith("No conformance changes.\n")


def test_the_diff_names_the_attribute_that_moved() -> None:
    def report(
        attributes: list[str], findings: list[dict[str, str]]
    ) -> dict[str, Any]:
        return {
            "targets": [
                {
                    "id": TARGET,
                    "signals": [
                        {
                            "type": "span",
                            "name": "demo.client",
                            "emitted": attributes,
                        }
                    ],
                    "findings": findings,
                }
            ]
        }

    changes = _markdown.render_diff(
        report(["demo.required"], [{"id": "unit_mismatch"}]),
        report(["demo.required", "demo.recommended"], []),
    )
    assert "**+** `demo.recommended`" in changes
    assert "  - findings `unit_mismatch` −1" in changes


def test_the_diff_names_a_denominator_that_moved_on_its_own() -> None:
    """A pin move changes coverage with no reduction having changed.

    The nightly rebuild opens its pull request off this diff, so a
    denominator-only move that rendered as nothing would land unexplained.
    """

    def report(declared: int, ref: str) -> dict[str, Any]:
        return {
            "domains": {
                "demo-conformance": {
                    "registry_repo": "open-telemetry/demo",
                    "registry_ref": ref,
                    "registry_dir": "model",
                }
            },
            "targets": [
                {
                    "id": TARGET,
                    "signals": [
                        {
                            "type": "span",
                            "name": "demo.client",
                            "emitted": ["demo.required"],
                            "coverage": {
                                "required": {
                                    "emitted": 1,
                                    "declared": declared,
                                }
                            },
                        }
                    ],
                    "findings": [],
                }
            ],
        }

    changes = _markdown.render_diff(report(1, "v1.0.0"), report(2, "v1.1.0"))
    # The pin first, because the cap drops from the end.
    assert changes.splitlines()[2] == (
        "- registry `demo-conformance` ref `v1.0.0` → `v1.1.0`"
    )
    assert "`required` coverage 1/1 → 1/2" in changes


def test_the_diff_reports_requirement_changes_with_equal_denominators() -> (
    None
):
    data = {"spans": {"demo.client": ["a"]}}

    def report(required: str, recommended: str) -> dict[str, Any]:
        signals = _aggregate.signal_coverage(
            data,
            {
                "spans": {
                    "demo.client": {
                        "attributes": {
                            required: "required",
                            recommended: "recommended",
                        },
                    }
                }
            },
        )
        return {"targets": [{"id": TARGET, "signals": signals}]}

    changes = _markdown.render_diff(report("a", "b"), report("b", "a"))
    assert "`required` coverage 1/1 → 0/1" in changes
    assert "`recommended` coverage 0/1 → 1/1" in changes


def test_the_diff_names_a_signal_that_appeared() -> None:
    """One line, not one per attribute: a rename moves every target at once."""
    signal = {
        "type": "metric",
        "name": "demo.duration",
        "emitted": ["demo.required"],
        "coverage": {"required": {"emitted": 1, "declared": 1}},
    }
    target = {"id": TARGET, "signals": [], "findings": []}
    changes = _markdown.render_diff(
        {"targets": [target]},
        {"targets": [{**target, "signals": [signal]}]},
    )
    lines = [line for line in changes.splitlines() if "- " in line]
    assert lines == [f"- `{TARGET}`", "  - `metric demo.duration` **added**"]

    gone = _markdown.render_diff(
        {"targets": [{**target, "signals": [signal]}]},
        {"targets": [target]},
    )
    assert "`metric demo.duration` **no longer emitted**" in gone


def test_the_diff_says_when_the_registry_stopped_declaring_a_signal() -> None:
    """Null coverage is "unknown", and worth a line of its own."""
    emitted = {"type": "span", "name": "demo.client", "emitted": []}
    scored = {
        **emitted,
        "coverage": {"required": {"emitted": 0, "declared": 1}},
    }
    unscored = {**emitted, "declared": None}

    def report(signal: dict[str, Any]) -> dict[str, Any]:
        return {
            "targets": [{"id": TARGET, "signals": [signal], "findings": []}]
        }

    changes = _markdown.render_diff(report(scored), report(unscored))
    assert "no longer declared by the registry" in changes
    assert "now declared by the registry" in _markdown.render_diff(
        report(unscored), report(scored)
    )


def test_an_unchanged_report_has_no_diff_to_show() -> None:
    same: dict[str, Any] = {
        "targets": [{"id": TARGET, "signals": [], "findings": []}]
    }
    assert _markdown.render_diff(same, same) == ""


def test_the_diff_reports_an_added_target() -> None:
    changes = _markdown.render_diff(
        {"targets": []},
        {"targets": [{"id": TARGET, "signals": [], "findings": []}]},
    )
    assert f"added `{TARGET}`" in changes


def test_a_diff_too_large_for_a_job_summary_is_truncated() -> None:
    """GitHub refuses a summary over 1 MiB, which would fail the rebuild."""
    wide = 4 * _markdown._CHANGES
    changes = _markdown.render_diff(
        {"targets": [{"id": TARGET, "signals": [], "findings": []}]},
        {
            "targets": [
                {"id": f"{TARGET}/{n}", "signals": [], "findings": []}
                for n in range(wide)
            ]
        },
    )
    lines = [line for line in changes.splitlines() if line.startswith("- ")]
    assert len(lines) == _markdown._CHANGES + 1
    assert lines[-1].endswith(
        f"and {wide + 1 - _markdown._CHANGES} further targets._"
    )


@pytest.mark.parametrize("preceding", [0, 1])
def test_an_oversized_target_keeps_some_changes(preceding: int) -> None:
    target = {"id": TARGET, "signals": []}
    signals = [
        {"type": "metric", "name": f"demo.{n:03d}", "emitted": []}
        for n in range(_markdown._CHANGES)
    ]
    changes = _markdown.render_diff(
        {"targets": [target]},
        {
            "targets": [
                *({"id": f"0-before-{n}"} for n in range(preceding)),
                {**target, "signals": signals},
                {"id": "z-after"},
            ]
        },
    )
    assert f"- `{TARGET}`\n  - `metric demo.000` **added**" in changes
    assert changes.count("**added**") == _markdown._CHANGES - preceding - 1
    omitted = preceding + 1
    noun = "change" if omitted == 1 else "changes"
    assert f"  - _…and {omitted} further {noun}._" in changes
    assert "\n- _…and 1 further target._" in changes
    assert "added `z-after`" not in changes


def test_attribute_changes_do_not_hide_a_coverage_denominator_move() -> None:
    def report(attribute: str, declared: int) -> dict[str, Any]:
        return {
            "targets": [
                {
                    "id": TARGET,
                    "signals": [
                        {
                            "type": "span",
                            "name": "demo.client",
                            "emitted": ["demo.recommended", attribute],
                            "coverage": {
                                "recommended": {
                                    "emitted": 1,
                                    "declared": declared,
                                }
                            },
                        }
                    ],
                }
            ]
        }

    changes = _markdown.render_diff(
        report("custom.old", 1), report("custom.new", 2)
    )
    assert "**+** `custom.new` **−** `custom.old`" in changes
    assert "`recommended` coverage 1/1 → 1/2" in changes


def test_a_coverage_move_the_attributes_explain_is_left_out() -> None:
    """Except for `required`, where a drop is the line a reviewer wants."""

    def report(
        emitted: list[str], required: int, recommended: int
    ) -> dict[str, Any]:
        signal = {
            "type": "span",
            "name": "demo.client",
            "emitted": emitted,
            "coverage": {
                "required": {"emitted": required, "declared": 1},
                "recommended": {"emitted": recommended, "declared": 1},
            },
        }
        return {"targets": [{"id": TARGET, "signals": [signal]}]}

    changes = _markdown.render_diff(report(["a", "b"], 1, 1), report([], 0, 0))
    assert "  - `span demo.client` **−** `a`, `b`" in changes
    assert "`required` coverage 1/1 → 0/1" in changes
    assert "`recommended` coverage" not in changes


def test_a_finding_that_moved_everywhere_is_listed_once() -> None:
    """A new check adds the same finding to every target in one run."""
    many = _markdown._WIDESPREAD

    def report(findings: list[dict[str, str]]) -> dict[str, Any]:
        return {
            "targets": [
                {"id": f"{TARGET}/{n}", "signals": [], "findings": findings}
                for n in range(many)
            ]
        }

    changes = _markdown.render_diff(
        report([{"id": "unit_mismatch"}]),
        report([{"id": "new_check"}, {"id": "new_check"}]),
    )
    assert (
        f"- finding `new_check` +{2 * many} across {many} targets" in changes
    )
    assert (
        f"- finding `unit_mismatch` −{many} across {many} targets" in changes
    )
    assert "<details>" not in changes
