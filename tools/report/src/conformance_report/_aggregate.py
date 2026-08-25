# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

"""Every committed reduction, joined to what the registry declared.

A ``data.json`` is a numerator. It records which of a signal's declared
attributes a run carried, and it cannot say how many there were to carry —
that is in the coverage model, weaver's resolution of the pinned registry,
which is a cache rather than a committed file. So the report joins the two and
commits the result, and the site it feeds needs neither weaver nor a registry.

The document carries the slice of the model it referenced for the same reason:
a reader asking "what was missing" is asking about the registry, and shipping
that answer beside the observation is what keeps the two from drifting apart.

Determinism is a requirement, not a nicety. The file is committed and gated by
``git diff``, so a rebuild that reorders a list is a failing build; and the
ecosystem registry downstream content-addresses what it ingests, so ordering
churn there reads as a change that never happened. Hence sorted keys, sorted
sequences, and no timestamp anywhere.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable, Mapping

from opentelemetry.conformance import Domain
from opentelemetry.conformance import domain as load_domain

from ._discover import DATA_FILE, Target, discover
from ._versions import versions as read_versions

SCHEMA_VERSION = 1

# The signal kinds a reduction records attributes for, mapped to the singular
# the report names one by. Entities are shaped differently and handled apart.
_SIGNAL_KINDS = {"spans": "span", "events": "event", "metrics": "metric"}

# The levels a score may be built from. The rest — every `conditionally_`
# level, `opt_in`, and the `_conditional` variants — are reported as counts
# only: whether their condition held is not in the data, so an absence there
# is not a gap. See the report's README.
SCORED_LEVELS = ("required", "recommended")


def _domains(targets: Iterable[Target]) -> dict[str, Domain]:
    """The domain behind each ``runner:`` the targets name.

    Resolving a domain resolves its coverage model, which fetches a registry
    and runs weaver the first time. Doing it once per distinct runner rather
    than once per target is the difference between two resolutions and 47.
    """
    resolved: dict[str, Domain] = {}
    for target in targets:
        name = target.runner
        if name is None or name in resolved:
            continue
        found = load_domain(name)
        if found is None:
            raise RuntimeError(
                f"{target.path} names runner {name!r}, which exposes no "
                "DOMAIN — the report cannot tell what registry it was "
                "measured against"
            )
        resolved[name] = found
    return resolved


def _coverage(
    declared: Mapping[str, str], emitted: Iterable[str]
) -> dict[str, dict[str, int]]:
    """Per requirement level, how much of it the run carried."""
    carried = set(emitted)
    counted: dict[str, dict[str, int]] = {}
    for attribute, level in declared.items():
        tally = counted.setdefault(level, {"emitted": 0, "declared": 0})
        tally["declared"] += 1
        if attribute in carried:
            tally["emitted"] += 1
    return dict(sorted(counted.items()))


def signal_coverage(
    data: Mapping[str, Any], model: Mapping[str, Any]
) -> list[dict[str, Any]]:
    """Each signal the run recorded, against what the registry declares.

    Shared with the timeline replay, which scores historical reductions the
    same way this scores the current one — the two must agree, or a point and
    the report it should end at disagree about the same run.

    A signal the model does not declare keeps ``declared: null`` rather than
    being dropped or scored zero. A reduction only records registry-declared
    signals, so this is not reachable from a matching pin — but a report may
    be built against a pin the data was not produced at, and the honest answer
    to "how much of it was covered" is then "unknown", not "none".
    """
    built: list[dict[str, Any]] = []
    for kind, singular in _SIGNAL_KINDS.items():
        for name, emitted in sorted(data.get(kind, {}).items()):
            entry: dict[str, Any] = {"type": singular, "name": name}
            declared = model.get(kind, {}).get(name)
            attributes = (declared or {}).get("attributes")
            if attributes is None:
                entry["emitted"] = sorted(emitted)
                entry["declared"] = None
                built.append(entry)
                continue
            entry["emitted"] = sorted(emitted)
            entry["missing"] = sorted(set(attributes) - set(emitted))
            entry["coverage"] = _coverage(attributes, emitted)
            # The identity the ecosystem explorer keys telemetry on, so a
            # signal here and a signal there are the same signal without a
            # translation step: spans by kind and attribute set, metrics and
            # events by name alone.
            identity: dict[str, Any] = {"attributes": sorted(emitted)}
            if singular == "span":
                identity["span_kind"] = declared.get("kind")
            entry["identity"] = identity
            built.append(entry)
    return built


def _summary(signals: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """One target's scored levels, summed over its signals."""
    totals = {
        level: {"emitted": 0, "declared": 0} for level in SCORED_LEVELS
    }
    for signal in signals:
        for level, tally in (signal.get("coverage") or {}).items():
            if level in totals:
                totals[level]["emitted"] += tally["emitted"]
                totals[level]["declared"] += tally["declared"]
    return totals


def _referenced(
    declared: Mapping[str, Any], data: Iterable[Mapping[str, Any]]
) -> dict[str, Any]:
    """The slice of one domain's model its targets actually referenced.

    The registries declare thousands of attributes across hundreds of signals;
    these scenarios touch a couple of dozen. Shipping the whole model would be
    most of the file and none of the answer.
    """
    wanted: dict[str, set[str]] = {kind: set() for kind in _SIGNAL_KINDS}
    entities: set[str] = set()
    for reduction in data:
        for kind in _SIGNAL_KINDS:
            wanted[kind].update(reduction.get(kind, {}))
        entities.update(reduction.get("entities", {}))

    slice_: dict[str, Any] = {}
    for kind, names in wanted.items():
        available = declared.get(kind, {})
        slice_[kind] = {
            name: available[name]
            for name in sorted(names)
            if name in available
        }
    available_entities = declared.get("entities", {})
    slice_["entities"] = {
        name: available_entities[name]
        for name in sorted(entities)
        if name in available_entities
    }
    return slice_


def build(root: Path) -> dict[str, Any]:
    """The whole report: every target, and the registry it was read against."""
    targets = discover(root)
    if not targets:
        raise RuntimeError(f"no conformance directories found under {root}")
    domains = _domains(targets)

    reductions = {
        target.id: json.loads(
            (target.directory / DATA_FILE).read_text(encoding="utf-8")
        )
        for target in targets
    }

    built: list[dict[str, Any]] = []
    for target in targets:
        data = reductions[target.id]
        found = domains.get(target.runner or "")
        model: Mapping[str, Any] = found.coverage_model if found else {}
        signals = signal_coverage(data, model)
        pins = read_versions(
            target.directory,
            root,
            target.language,
            target.spec.instrumentation_library,
            target.spec.instrumented_library,
        )
        built.append(
            {
                "id": target.id,
                "path": target.path,
                "domain": target.domain,
                "language": target.language,
                "side": target.side,
                "runner": target.runner,
                "instrumented_library": target.spec.instrumented_library,
                "instrumentation_library": (
                    target.spec.instrumentation_library
                ),
                # The directory the implementation lives in. A coordinate does
                # not distinguish them: `opentelemetry-instrumentation-openai`
                # is OpenLLMetry's and `...-genai-openai` is OpenTelemetry's,
                # and both shorten to "openai". The tree already solves this —
                # the READMEs name the segment after whatever produced the
                # telemetry, `openllmetry` beside `opentelemetry-openai` — so
                # that is the label a column gets, with the coordinate behind
                # it for anyone who needs to install the thing.
                "label": target.instrumentation,
                "versions": pins.as_dict(),
                "scenario_classes": sorted(target.spec.scenarios),
                "signals": signals,
                "entities": data.get("entities", {}),
                "findings": data.get("findings", []),
                "summary": {
                    **_summary(signals),
                    "findings": len(data.get("findings", [])),
                },
            }
        )

    registry: dict[str, Any] = {}
    for name, found in sorted(domains.items()):
        registry[name] = _referenced(
            found.coverage_model,
            [
                reductions[target.id]
                for target in targets
                if target.runner == name
            ],
        )

    return {
        "schema_version": SCHEMA_VERSION,
        "domains": {
            name: {
                "registry_repo": found.repo,
                "registry_ref": found.ref,
                "registry_dir": found.registry_dir,
            }
            for name, found in sorted(domains.items())
        },
        "registry": registry,
        "targets": built,
    }


def render(document: Mapping[str, Any]) -> str:
    """The report as it is committed: stable, and readable in a diff."""
    return json.dumps(document, indent=2, sort_keys=True) + "\n"
