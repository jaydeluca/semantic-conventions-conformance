# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

"""The report's changes, for a job summary or a pull request body."""

from __future__ import annotations

import collections
import gzip
from typing import Any, Iterable, Mapping

from ._aggregate import render as render_json

_SITE = "https://open-telemetry.github.io/semantic-conventions-conformance/"

# A finding that moves the same way in this many targets is usually one
# cause, such as a new check, so it is listed once rather than per target.
_WIDESPREAD = 10

# Limit large diffs so the job summary and PR body remain readable.
_CHANGES = 200


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}{'' if count == 1 else 's'}"


def _signed(delta: int, text: str) -> str:
    return f"{'+' if delta >= 0 else '−'}{text}"


def _bytes(count: int) -> str:
    if count < 1000:
        return f"{count} B"
    if count < 1_000_000:
        return f"{count / 1000:.1f} KB"
    return f"{count / 1_000_000:.2f} MB"


def _sizes(document: Mapping[str, Any]) -> tuple[int, int]:
    """The committed file's size, and roughly what a browser downloads."""
    raw = render_json(document).encode()
    return len(raw), len(gzip.compress(raw, mtime=0))


def _findings(target: Mapping[str, Any]) -> collections.Counter[str]:
    return collections.Counter(
        f["id"] for f in target.get("findings", []) if "id" in f
    )


def _headline(
    document: Mapping[str, Any], before: Mapping[str, Any] | None
) -> str:
    def total(report: Mapping[str, Any]) -> int:
        return sum(sum(_findings(t).values()) for t in report["targets"])

    raw, zipped = _sizes(document)
    findings = _plural(total(document), "finding")
    size = f"{_bytes(raw)}, {_bytes(zipped)} gzipped"
    if before is not None:
        was_raw, was_zipped = _sizes(before)
        delta = total(document) - total(before)
        findings += f" ({_signed(delta, str(abs(delta)))})"
        grew, zip_grew = raw - was_raw, zipped - was_zipped
        size = (
            f"{_bytes(raw)} ({_signed(grew, _bytes(abs(grew)))}), "
            f"{_bytes(zipped)} gzipped "
            f"({_signed(zip_grew, _bytes(abs(zip_grew)))})"
        )
    return (
        f"{_plural(len(document.get('targets', [])), 'target')}, {findings}. "
        f"Report {size}. [View the site]({_SITE})."
    )


def _short(ref: str) -> str:
    """Abbreviate a commit, leaving tags alone."""
    is_sha = len(ref) == 40 and all(c in "0123456789abcdef" for c in ref)
    return ref[:12] if is_sha else ref


def _registries(document: Mapping[str, Any]) -> str:
    pins: dict[tuple[str, str], list[str]] = collections.defaultdict(list)
    for name, pin in sorted(document.get("domains", {}).items()):
        pins[(pin["registry_repo"], pin["registry_ref"])].append(f"`{name}`")
    return "Registries: " + "; ".join(
        f"{repo} @ `{_short(ref)}` ({', '.join(names)})"
        for (repo, ref), names in sorted(pins.items())
    )


def render(
    document: Mapping[str, Any], before: Mapping[str, Any] | None = None
) -> str:
    """A markdown summary of one report, and what changed since `before`."""
    lines = [
        "## Semantic-convention conformance",
        "",
        _headline(document, before),
    ]
    if document.get("domains"):
        lines += ["", _registries(document)]
    if before is not None:
        lines += [
            "",
            render_diff(before, document) or "No conformance changes.",
        ]
    return "\n".join(lines).rstrip("\n") + "\n"


def render_diff(before: Mapping[str, Any], after: Mapping[str, Any]) -> str:
    """Return a Markdown list of conformance changes between two reports."""

    def index(document: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
        return {t["id"]: t for t in document.get("targets", [])}

    old, new = index(before), index(after)
    # Registry pins first and outside the fold: they explain the rest.
    lines: list[str] = list(_registry_diff(before, after))

    moved = {
        target_id: _findings(new[target_id]) - _findings(old[target_id])
        for target_id in old.keys() & new.keys()
    }
    falling = {
        target_id: _findings(old[target_id]) - _findings(new[target_id])
        for target_id in moved
    }
    widespread: set[tuple[str, bool]] = set()
    for rising, deltas in ((True, moved), (False, falling)):
        spread = collections.Counter(k for d in deltas.values() for k in d)
        for name, count in sorted(spread.items()):
            if count < _WIDESPREAD:
                continue
            widespread.add((name, rising))
            change = sum(d[name] for d in deltas.values())
            lines.append(
                f"- finding `{name}` {'+' if rising else '−'}{change} "
                f"across {count} targets"
            )

    blocks: list[list[str]] = []
    for target_id in sorted(set(old) | set(new)):
        if target_id not in old:
            blocks.append([f"- added `{target_id}`"])
        elif target_id not in new:
            blocks.append([f"- removed `{target_id}`"])
        else:
            items = list(
                _target_diff(old[target_id], new[target_id], widespread)
            )
            if items:
                blocks.append(
                    [f"- `{target_id}`", *(f"  {item}" for item in items)]
                )

    if blocks:
        shown: list[str] = []
        kept = 0
        for block in blocks:
            if len(shown) + len(block) > _CHANGES:
                break
            shown += block
            kept += 1
        if kept < len(blocks):
            shown.append(
                f"- _…and {_plural(len(blocks) - kept, 'further target')}._"
            )
        if lines:
            lines.append("")
        lines += [
            f"<details><summary>Changes in "
            f"{_plural(len(blocks), 'target')}</summary>",
            "",
            *shown,
            "",
            "</details>",
        ]
    if not lines:
        return ""
    return "\n".join(["### Conformance changes", "", *lines]) + "\n"


def _registry_diff(
    before: Mapping[str, Any], after: Mapping[str, Any]
) -> Iterable[str]:
    """Yield changes to registry pins between two reports."""
    old: Mapping[str, Mapping[str, Any]] = before.get("domains", {})
    new: Mapping[str, Mapping[str, Any]] = after.get("domains", {})
    for name in sorted(set(old) | set(new)):
        was, now = old.get(name), new.get(name)
        if was == now:
            continue
        if now is None:
            yield f"- registry `{name}` removed"
            continue
        if was is None:
            yield f"- registry `{name}` added at `{now['registry_ref']}`"
            continue
        for field in ("registry_repo", "registry_ref", "registry_dir"):
            if was.get(field) != now.get(field):
                what = field.removeprefix("registry_")
                yield (
                    f"- registry `{name}` {what} `{was.get(field)}` → "
                    f"`{now.get(field)}`"
                )


def _signals(target: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    return {f"{s['type']} {s['name']}": s for s in target.get("signals", [])}


def _signal_diff(
    signal: str, old: Mapping[str, Any], new: Mapping[str, Any]
) -> Iterable[str]:
    old_emitted = set(old.get("emitted", []))
    new_emitted = set(new.get("emitted", []))
    attributes = " ".join(
        f"**{sign}** " + ", ".join(f"`{a}`" for a in sorted(names))
        for sign, names in (
            ("+", new_emitted - old_emitted),
            ("−", old_emitted - new_emitted),
        )
        if names
    )
    if attributes:
        yield f"- `{signal}` {attributes}"

    # Requirement changes can move coverage without changing emitted names.
    was: Mapping[str, Mapping[str, int]] | None = old.get("coverage")
    now: Mapping[str, Mapping[str, int]] | None = new.get("coverage")
    if was is None and now is None:
        return
    if was is None or now is None:
        state = "now" if was is None else "no longer"
        yield f"- `{signal}` {state} declared by the registry"
        return
    for level in sorted(set(was) | set(now)):
        before = was.get(level, {"emitted": 0, "declared": 0})
        after = now.get(level, {"emitted": 0, "declared": 0})
        # The attribute line already explains most moves; a required one
        # is still worth spelling out.
        if before != after and (not attributes or level == "required"):
            yield (
                f"- `{signal}` `{level}` coverage "
                f"{before['emitted']}/{before['declared']} → "
                f"{after['emitted']}/{after['declared']}"
            )


def _target_diff(
    old: Mapping[str, Any],
    new: Mapping[str, Any],
    widespread: set[tuple[str, bool]],
) -> Iterable[str]:
    was, now = _signals(old), _signals(new)
    for signal in sorted(set(was) | set(now)):
        before, after = was.get(signal), now.get(signal)
        # Report added and removed signals once, without listing each attribute.
        if before is None:
            yield f"- `{signal}` **added**"
        elif after is None:
            yield f"- `{signal}` **no longer emitted**"
        else:
            yield from _signal_diff(signal, before, after)

    before_findings, now_findings = _findings(old), _findings(new)
    findings: list[str] = []
    for name in sorted(set(before_findings) | set(now_findings)):
        delta = now_findings[name] - before_findings[name]
        if delta and (name, delta > 0) not in widespread:
            findings.append(f"`{name}` {_signed(delta, str(abs(delta)))}")
    if findings:
        yield f"- findings {', '.join(findings)}"
