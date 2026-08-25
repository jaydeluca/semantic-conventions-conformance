# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

"""The report over time, replayed out of git.

The reductions are committed, so the history of what instrumentations emitted
is already recorded and needs no store of its own: every commit that touched a
``data.json`` is a point on the axis, and git reads each one back. That is
worth more than appending snapshots somewhere. It is retroactive, so the axis
is fully populated the day this lands rather than starting empty; it cannot
drift from the commits it describes; and a schema change is replayed rather
than migrated.

Nothing here is committed. A file built from history can only describe the
commits before the one it would be committed in, so committing it would
publish a timeline that is always one commit stale.

**The denominator is today's registry, at every point.** A run is scored
against the coverage model this build resolved, not the one its own commit
pinned. Otherwise a registry bump that adds a required attribute would bend
every line on the chart at once, and a reader would see instrumentations
regress in a week none of them changed. Scoring against one registry makes the
line mean what it looks like it means: what the instrumentation did. Which
registry each report was actually read against is in ``conformance.json``.

The replay tolerates shapes the reduction no longer has. ``findings`` and
``entities`` were both added after it first appeared, so an early point is
genuinely missing them rather than reporting zero.
"""

from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path
from typing import Any, Iterable, Mapping

from ._aggregate import SCHEMA_VERSION, SCORED_LEVELS, signal_coverage
from ._discover import DATA_FILE, SCENARIO_ROOT

logger = logging.getLogger(__name__)

# How far back to look. Bounded so a long-lived repo doesn't turn one page
# load into thousands of points nobody can read.
DEFAULT_LIMIT = 200

# git's NUL-delimited batch protocol: one `<sha> <type> <size>` header line,
# then the bytes, then a newline.
_BATCH = ("cat-file", "--batch")


def _git(root: Path, *arguments: str) -> str:
    return subprocess.run(
        ("git", *arguments),
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def _commits(root: Path, limit: int) -> list[tuple[str, str, str]]:
    """Commits that touched any reduction, oldest first."""
    output = _git(
        root,
        "log",
        f"--max-count={limit}",
        "--date=short",
        "--format=%H%x00%ad%x00%s",
        "--",
        f"{SCENARIO_ROOT}/**/{DATA_FILE}",
    )
    rows = [
        (parts[0], parts[1], parts[2])
        for line in output.splitlines()
        if len(parts := line.split("\0")) == 3
    ]
    return list(reversed(rows))


def _reductions(root: Path, commit: str) -> dict[str, Any]:
    """Every reduction in one commit, keyed by target id.

    Read through one ``cat-file --batch`` rather than a ``git show`` per file:
    a replay is 47 files times as many commits as have ever touched one, and
    that is the difference between one process and several hundred.
    """
    listing = _git(root, "ls-tree", "-r", "--name-only", commit)
    paths = [
        line
        for line in listing.splitlines()
        if line.startswith(f"{SCENARIO_ROOT}/") and line.endswith(DATA_FILE)
    ]
    if not paths:
        return {}

    process = subprocess.run(
        ("git", *_BATCH),
        cwd=root,
        input="".join(f"{commit}:{path}\n" for path in paths),
        check=True,
        capture_output=True,
        text=True,
    )
    found: dict[str, Any] = {}
    stream = process.stdout
    offset = 0
    for path in paths:
        end = stream.find("\n", offset)
        if end < 0:
            break
        header = stream[offset:end].split()
        if len(header) != 3:
            # `<spec> missing` — the path is in the tree but unreadable.
            offset = end + 1
            continue
        size = int(header[2])
        body = stream[end + 1 : end + 1 + size]
        offset = end + 1 + size + 1
        target = path[len(SCENARIO_ROOT) + 1 : -(len(DATA_FILE) + 1)]
        try:
            found[target] = json.loads(body)
        except json.JSONDecodeError:
            logger.warning("%s:%s is not JSON; skipped", commit[:12], path)
    return found


def _summary(
    data: Mapping[str, Any], model: Mapping[str, Any]
) -> dict[str, Any]:
    """One reduction, scored to what a trend line and a change feed need."""
    totals = {
        level: [0, 0] for level in SCORED_LEVELS
    }
    attributes = 0
    for signal in signal_coverage(data, model):
        attributes += len(signal.get("emitted", ()))
        for level, tally in (signal.get("coverage") or {}).items():
            if level in totals:
                totals[level][0] += tally["emitted"]
                totals[level][1] += tally["declared"]
    # Absent rather than empty: `findings` was added to the reduction after
    # it first appeared, so a commit before that measured no violations *and
    # recorded none* — which is not the same as having had none. Null makes
    # the chart show a gap there instead of a flattering zero.
    findings = data.get("findings")
    return {
        **totals,
        "attributes": attributes,
        "findings": None if findings is None else len(findings),
        # Named, so the change feed can say which violation appeared without
        # loading every historical reduction a second time.
        "finding_ids": (
            None
            if findings is None
            else sorted(
                {
                    f["id"]
                    for f in findings
                    if isinstance(f, dict) and "id" in f
                }
            )
        ),
    }


def build(
    root: Path,
    models: Mapping[str, Mapping[str, Any]],
    *,
    limit: int = DEFAULT_LIMIT,
) -> dict[str, Any]:
    """Every commit that moved a reduction, as points on a time axis.

    ``models`` maps a domain directory to the coverage model to score it
    against — see the note above on why that is one model rather than the pin
    each commit carried.
    """
    points: list[dict[str, Any]] = []
    unknown: set[str] = set()
    for commit, date, subject in _commits(root, limit):
        scored: dict[str, Any] = {}
        for target, data in sorted(_reductions(root, commit).items()):
            domain = target.partition("/")[0]
            model = models.get(domain)
            if model is None:
                unknown.add(domain)
                continue
            scored[target] = _summary(data, model)
        points.append(
            {
                "commit": commit[:12],
                "date": date,
                "subject": subject,
                "targets": scored,
            }
        )
    if unknown:
        # Loud rather than silent: a domain with no model is coverage the
        # timeline is quietly missing, which is the one thing a chart hides.
        logger.warning(
            "no coverage model for %s — targets under it are not on the "
            "timeline",
            ", ".join(sorted(unknown)),
        )
    return {"schema_version": SCHEMA_VERSION, "points": points}


def render(document: Mapping[str, Any]) -> str:
    """Compact: this one is published, never committed or read in a diff."""
    return json.dumps(document, separators=(",", ":"), sort_keys=True) + "\n"


def models_for(targets: Iterable[Any]) -> dict[str, str]:
    """Which runner each domain directory is measured by.

    A path is how a historical reduction is identified — there is no spec to
    read at a commit that may not have had one — so the domain directory has
    to resolve to a registry. Every directory holds one domain today; a second
    one under the same directory would need this to key on more than the path.
    """
    mapping: dict[str, str] = {}
    for target in targets:
        if target.runner is not None:
            mapping.setdefault(target.domain, target.runner)
    return mapping
