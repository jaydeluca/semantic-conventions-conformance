# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

"""The report this repo actually produces.

The unit tests above prove the join is right on data they invented. These
assert against values established by reading the 47 committed reductions
directly, so a change that quietly drops targets or double-counts findings
fails here rather than on the site.

Skipped when the committed report is absent — the report needs weaver and a
fetched registry to rebuild, which not every checkout has.
"""

from __future__ import annotations

import collections
import json
from pathlib import Path

import pytest

REPORT = Path(__file__).parents[3] / "docs" / "data" / "conformance.json"

pytestmark = pytest.mark.skipif(
    not REPORT.is_file(), reason="docs/data/conformance.json is not built"
)


@pytest.fixture(scope="module")
def report() -> dict[str, object]:
    return json.loads(REPORT.read_text(encoding="utf-8"))


def targets(report: dict[str, object]) -> list[dict[str, object]]:
    found = report["targets"]
    assert isinstance(found, list)
    return found


def test_every_conformance_directory_is_in_the_report(
    report: dict[str, object],
) -> None:
    """One target per committed reduction, none dropped and none invented."""
    root = REPORT.parents[2]
    on_disk = {
        path.parent.relative_to(root / "scenarios").as_posix()
        for path in (root / "scenarios").rglob("data.json")
    }
    assert {t["id"] for t in targets(report)} == on_disk


def test_the_domains_and_languages_are_what_the_tree_holds(
    report: dict[str, object],
) -> None:
    by_domain = collections.Counter(t["domain"] for t in targets(report))
    assert by_domain == {"http": 35, "gen-ai": 12}
    http = collections.Counter(
        t["language"] for t in targets(report) if t["domain"] == "http"
    )
    assert http == {"java": 29, "dotnet": 2, "js": 2, "python": 2}


def test_findings_are_carried_over_exactly(report: dict[str, object]) -> None:
    kinds = collections.Counter(
        finding["id"] for t in targets(report) for finding in t["findings"]
    )
    assert sum(kinds.values()) == 160
    assert kinds["missing_attribute"] == 88
    assert kinds["recommended_attribute_not_present"] == 18
    assert sum(1 for t in targets(report) if not t["findings"]) == 29


def test_a_fully_conforming_target_is_not_scored_down_for_opt_ins(
    report: dict[str, object],
) -> None:
    """The reason there is no blended score.

    okhttp through the java agent carries every required and every recommended
    attribute on its span, and none of the eleven opt-ins — which is correct
    behaviour. A single percentage over all five levels would rank it around
    40% and read as a failing implementation.
    """
    (found,) = [
        t
        for t in targets(report)
        if t["id"] == "http/java/okhttp/opentelemetry-javaagent/client"
    ]
    (span,) = [s for s in found["signals"] if s["name"] == "http.client"]
    assert span["coverage"]["required"] == {"emitted": 4, "declared": 4}
    assert span["coverage"]["recommended"] == {"emitted": 2, "declared": 2}
    assert span["coverage"]["opt_in"] == {"emitted": 0, "declared": 11}
    assert found["summary"]["findings"] == 0


def test_every_target_resolved_an_instrumentation_version(
    report: dict[str, object],
) -> None:
    """The label on the time axis, and the join key for the explorer."""
    without = [
        t["id"]
        for t in targets(report)
        if not t["versions"]["instrumentation"]
    ]
    assert without == []


def test_the_pinned_versions_are_the_ones_the_scenarios_declare(
    report: dict[str, object],
) -> None:
    expected = {
        "http/java/okhttp/opentelemetry-javaagent/client": "2.31.1",
        "http/js/express/opentelemetry-express/server": "0.69.0",
        "http/dotnet/aspnetcore/opentelemetry-aspnetcore/server": "1.17.0",
        "gen-ai/python/openai/opentelemetry-openai": "1.1b0",
    }
    found = {
        t["id"]: t["versions"]["instrumentation"]
        for t in targets(report)
        if t["id"] in expected
    }
    assert found == expected


def test_competing_implementations_of_one_library_are_distinguishable(
    report: dict[str, object],
) -> None:
    """The comparison the repo exists to make.

    Three instrumentations exercise the openai client directly, and two of them
    have coordinates that shorten to the same word — OpenLLMetry publishes
    `opentelemetry-instrumentation-openai` and OpenTelemetry's own is
    `opentelemetry-instrumentation-genai-openai` — so the label has to come
    from the tree rather than from the package name.

    A fourth reaches OpenAI through langchain, and declares `langchain-openai`
    as what it instruments, which is why it is not in this list.
    """
    labels = sorted(
        t["label"]
        for t in targets(report)
        if t["instrumented_library"] == "openai"
    )
    assert labels == ["openinference", "openllmetry", "opentelemetry-openai"]

    coordinates = {
        t["instrumentation_library"]
        for t in targets(report)
        if t["instrumented_library"] == "openai"
    }
    assert "opentelemetry-instrumentation-openai" in coordinates
    assert "opentelemetry-instrumentation-genai-openai" in coordinates


def test_the_registry_slice_covers_every_signal_a_target_emitted(
    report: dict[str, object],
) -> None:
    """A signal with no declaration shipped would score as unknown on the site."""
    registry = report["registry"]
    unresolved = [
        (t["id"], s["name"])
        for t in targets(report)
        for s in t["signals"]
        if s.get("declared", "present") is None
    ]
    assert unresolved == []
    for target in targets(report):
        for signal in target["signals"]:
            declared = registry[target["runner"]][f"{signal['type']}s"]
            assert signal["name"] in declared


def test_the_report_carries_no_timestamp(report: dict[str, object]) -> None:
    """It is gated by `git diff`, so anything per-run makes CI fail forever."""
    text = REPORT.read_text(encoding="utf-8").lower()
    for word in ("timestamp", "generated_at", '"date"', "built_at"):
        assert word not in text
