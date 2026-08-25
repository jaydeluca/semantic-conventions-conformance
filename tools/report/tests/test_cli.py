# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

"""The verbs, and the freshness gate CI leans on."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from conformance_report import _aggregate, _cli, _markdown
from conftest import MODEL, write_target

TARGET = "demo/python/demo/opentelemetry-demo"


@pytest.fixture(autouse=True)
def _one_domain(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stand in for the wrapper a `runner:` would resolve to.

    Resolving the real thing fetches a registry and runs weaver; what these
    tests are about is the verbs, not the resolution.
    """

    class Stub:
        name = "demo-conformance"
        repo = "open-telemetry/demo"
        ref = "v1.0.0"
        registry_dir = "model"
        coverage_model = MODEL

    monkeypatch.setattr(_aggregate, "load_domain", lambda _name: Stub())


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
    """The gate below is a byte comparison, so this is what makes it usable."""
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
    assert "1 targets across 1 python" in printed
    assert "open-telemetry/demo @ `v1.0.0`" in printed


def test_the_diff_names_the_attribute_that_moved() -> None:
    def report(attributes: list[str], findings: list[dict[str, str]]) -> dict[str, Any]:
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
    assert "finding `unit_mismatch` −1" in changes


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
