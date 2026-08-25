# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

"""The report as a table, for a job summary or a pull request.

Small on purpose. A run in CI is where someone first sees that conformance
moved, and what they need there is the shape of the whole thing and which
targets are worth opening — not the report, which is a click away.
"""

from __future__ import annotations

import collections
from typing import Any, Iterable, Mapping

from ._aggregate import SCORED_LEVELS

# How many rows the per-target table is worth. Beyond this it stops being a
# summary; the count of what was left out is printed instead.
_ROWS = 15


def _ratio(tally: Mapping[str, int] | None) -> str:
    if not tally or not tally.get("declared"):
        return "—"
    emitted, declared = tally["emitted"], tally["declared"]
    return f"{emitted}/{declared} ({emitted * 100 // declared}%)"


def _shortfall(target: Mapping[str, Any]) -> tuple[int, int]:
    """How badly a target wants looking at: gaps first, then findings."""
    summary = target.get("summary", {})
    missed = sum(
        summary.get(level, {}).get("declared", 0)
        - summary.get(level, {}).get("emitted", 0)
        for level in SCORED_LEVELS
    )
    return (-missed, -summary.get("findings", 0))


def render(document: Mapping[str, Any]) -> str:
    """A markdown summary of one report."""
    targets: list[Mapping[str, Any]] = list(document.get("targets", []))
    lines: list[str] = ["## Semantic-convention conformance", ""]

    languages = collections.Counter(t["language"] for t in targets)
    findings = collections.Counter(
        finding["id"]
        for t in targets
        for finding in t.get("findings", [])
        if "id" in finding
    )
    clean = sum(1 for t in targets if not t.get("findings"))

    lines += [
        f"{len(targets)} targets across "
        + ", ".join(
            f"{count} {language}"
            for language, count in sorted(languages.items())
        )
        + f". {clean} with no findings, {sum(findings.values())} findings "
        f"of {len(findings)} kinds.",
        "",
    ]

    for name, pin in sorted(document.get("domains", {}).items()):
        lines.append(
            f"- `{name}` — {pin['registry_repo']} @ `{pin['registry_ref']}`"
        )
    lines.append("")

    lines += [
        "| Target | Instrumentation | Required | Recommended | Findings |",
        "| --- | --- | --- | --- | --- |",
    ]
    ranked = sorted(targets, key=_shortfall)
    for target in ranked[:_ROWS]:
        summary = target.get("summary", {})
        version = (target.get("versions") or {}).get("instrumentation")
        lines.append(
            "| `{id}` | `{library}`{version} | {required} | {recommended} "
            "| {findings} |".format(
                id=target["id"],
                library=target["instrumentation_library"],
                version=f" {version}" if version else "",
                required=_ratio(summary.get("required")),
                recommended=_ratio(summary.get("recommended")),
                findings=summary.get("findings", 0) or "—",
            )
        )
    if len(ranked) > _ROWS:
        lines.append("")
        lines.append(
            f"_{len(ranked) - _ROWS} further targets not shown; "
            "the full report is in `docs/data/conformance.json`._"
        )

    if findings:
        lines += ["", "<details><summary>Findings by kind</summary>", ""]
        lines += ["| Finding | Count |", "| --- | --- |"]
        for name, count in findings.most_common():
            lines.append(f"| `{name}` | {count} |")
        lines += ["", "</details>"]

    return "\n".join(lines) + "\n"


def render_diff(
    before: Mapping[str, Any], after: Mapping[str, Any]
) -> str:
    """What changed between two reports, or nothing if they agree."""
    def index(document: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
        return {t["id"]: t for t in document.get("targets", [])}

    old, new = index(before), index(after)
    changes: list[str] = []
    for target_id in sorted(set(old) | set(new)):
        if target_id not in old:
            changes.append(f"- added `{target_id}`")
            continue
        if target_id not in new:
            changes.append(f"- removed `{target_id}`")
            continue
        changes.extend(_target_diff(target_id, old[target_id], new[target_id]))
    if not changes:
        return ""
    return "\n".join(["### Conformance changes", "", *changes]) + "\n"


def _emitted(target: Mapping[str, Any]) -> dict[str, set[str]]:
    return {
        f"{s['type']} {s['name']}": set(s.get("emitted", []))
        for s in target.get("signals", [])
    }


def _target_diff(
    target_id: str, old: Mapping[str, Any], new: Mapping[str, Any]
) -> Iterable[str]:
    old_attributes, new_attributes = _emitted(old), _emitted(new)
    for signal in sorted(set(old_attributes) | set(new_attributes)):
        gained = new_attributes.get(signal, set()) - old_attributes.get(
            signal, set()
        )
        lost = old_attributes.get(signal, set()) - new_attributes.get(
            signal, set()
        )
        for attribute in sorted(gained):
            yield f"- `{target_id}` `{signal}` **+** `{attribute}`"
        for attribute in sorted(lost):
            yield f"- `{target_id}` `{signal}` **−** `{attribute}`"

    before = collections.Counter(
        f["id"] for f in old.get("findings", []) if "id" in f
    )
    now = collections.Counter(
        f["id"] for f in new.get("findings", []) if "id" in f
    )
    for name in sorted(set(before) | set(now)):
        delta = now[name] - before[name]
        if delta:
            sign = "+" if delta > 0 else "−"
            yield f"- `{target_id}` finding `{name}` {sign}{abs(delta)}"
