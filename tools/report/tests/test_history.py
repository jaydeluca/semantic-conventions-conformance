# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

"""Replaying the timeline out of git."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from conformance_report import _history, discover
from conftest import MODEL, git, write_target

TARGET = "demo/python/demo/opentelemetry-demo"
MODELS: dict[str, Any] = {"demo": MODEL}


def repo(root: Path) -> None:
    git(root, "init", "--quiet", "--initial-branch=main")


def commit(root: Path, message: str) -> None:
    git(root, "add", "-A")
    git(root, "commit", "--quiet", "-m", message)


def reduction(attributes: list[str], **extra: Any) -> dict[str, Any]:
    return {
        "spans": {"demo.client": attributes},
        "events": {},
        "metrics": {},
        "entities": {},
        **extra,
    }


def test_the_timeline_is_retroactive(tmp_path: Path) -> None:
    """Every commit that ever touched a reduction is already a point.

    This is the whole reason the replay reads the committed reductions rather
    than the report: a timeline that only started when the report landed would
    be empty on the day it landed.
    """
    repo(tmp_path)
    write_target(tmp_path, TARGET, data=reduction(["demo.required"], findings=[]))
    commit(tmp_path, "first")
    write_target(
        tmp_path,
        TARGET,
        data=reduction(["demo.required", "demo.recommended"], findings=[]),
    )
    commit(tmp_path, "second")

    points = _history.build(tmp_path, MODELS)["points"]
    assert [p["subject"] for p in points] == ["first", "second"]
    assert points[0]["targets"][TARGET]["recommended"] == [0, 1]
    assert points[1]["targets"][TARGET]["recommended"] == [1, 1]


def test_a_reduction_without_findings_reports_null_not_zero(
    tmp_path: Path,
) -> None:
    """`findings` was added after the reduction existed.

    Zero would read as "no violations" for a commit that measured none, which
    is a flattering lie; null makes the chart show the gap it is.
    """
    repo(tmp_path)
    write_target(tmp_path, TARGET, data=reduction(["demo.required"]))
    commit(tmp_path, "before findings existed")
    write_target(tmp_path, TARGET, data=reduction(["demo.required"], findings=[]))
    commit(tmp_path, "findings recorded")

    points = _history.build(tmp_path, MODELS)["points"]
    assert points[0]["targets"][TARGET]["findings"] is None
    assert points[0]["targets"][TARGET]["finding_ids"] is None
    assert points[1]["targets"][TARGET]["findings"] == 0
    assert points[1]["targets"][TARGET]["finding_ids"] == []


def test_finding_kinds_are_named_so_a_change_can_be_described(
    tmp_path: Path,
) -> None:
    repo(tmp_path)
    write_target(
        tmp_path,
        TARGET,
        data=reduction(
            ["demo.required"],
            findings=[{"id": "unit_mismatch"}, {"id": "unit_mismatch"}],
        ),
    )
    commit(tmp_path, "one kind twice")
    point = _history.build(tmp_path, MODELS)["points"][0]
    assert point["targets"][TARGET]["findings"] == 2
    assert point["targets"][TARGET]["finding_ids"] == ["unit_mismatch"]


def test_a_target_added_later_appears_only_from_then(tmp_path: Path) -> None:
    repo(tmp_path)
    write_target(tmp_path, TARGET, data=reduction(["demo.required"], findings=[]))
    commit(tmp_path, "one target")
    write_target(
        tmp_path,
        "demo/python/other/opentelemetry-other",
        data=reduction(["demo.required"], findings=[]),
    )
    commit(tmp_path, "two targets")
    points = _history.build(tmp_path, MODELS)["points"]
    assert len(points[0]["targets"]) == 1
    assert len(points[1]["targets"]) == 2


def test_a_domain_with_no_model_is_left_off_rather_than_scored_zero(
    tmp_path: Path,
) -> None:
    """Silently scoring it zero would put a false regression on the chart."""
    repo(tmp_path)
    write_target(
        tmp_path,
        "mystery/python/demo/opentelemetry-demo",
        data=reduction(["demo.required"], findings=[]),
    )
    commit(tmp_path, "an unknown domain")
    points = _history.build(tmp_path, MODELS)["points"]
    assert points[0]["targets"] == {}


def test_the_limit_bounds_the_replay(tmp_path: Path) -> None:
    repo(tmp_path)
    for index in range(4):
        write_target(
            tmp_path,
            TARGET,
            data=reduction(["demo.required"] * (1 if index % 2 else 0) or [], findings=[]),
        )
        write_target(
            tmp_path,
            f"demo/python/n{index}/opentelemetry-demo",
            data=reduction(["demo.required"], findings=[]),
        )
        commit(tmp_path, f"commit {index}")
    assert len(_history.build(tmp_path, MODELS, limit=2)["points"]) == 2


def test_rendering_is_compact(tmp_path: Path) -> None:
    """Published, never committed, so it is bytes rather than a diff."""
    text = _history.render({"schema_version": 1, "points": []})
    assert text == '{"points":[],"schema_version":1}\n'
    del tmp_path


def test_models_for_maps_a_domain_directory_to_its_runner(
    tmp_path: Path,
) -> None:
    """A historical reduction is identified by path; the path must resolve."""
    write_target(tmp_path, "demo/python/a/otel-a", runner="demo-conformance")
    write_target(tmp_path, "other/js/b/otel-b", runner="other-conformance")
    assert _history.models_for(discover(tmp_path)) == {
        "demo": "demo-conformance",
        "other": "other-conformance",
    }
