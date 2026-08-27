# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

"""Every conformance directory in a checkout, with what it declared.

The runner never reads a path for meaning, and a data file says nothing about
itself, so identity comes from the ``conformance.yaml`` beside it. One thing
is only in the path: the language. Nothing in a directory's declarations names
it — ``runner:`` names the domain, and the same domain spans four of them — so
the tree is the only place to read it from.

That makes the layout a contract of the *reporting* layer rather than of the
runner::

    scenarios/<domain>/<language>/<library>/<instrumentation>[/<side>]

which the package coordinates corroborate: ``instrumentation_library`` is
already ecosystem-native per language, Maven for java and npm for js, so a
target whose language and coordinate disagree is a mislaid directory.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from opentelemetry.conformance import PackageSpec, load_spec

# What a conformance directory is recognised by, and the reduction beside it.
SPEC_FILE = "conformance.yaml"
DATA_FILE = "data.json"

# The root the layout above is relative to.
SCENARIO_ROOT = "scenarios"

# The trailing segment naming which half of a two-sided domain a directory
# holds. HTTP splits them because coverage reduces everything a package
# emitted, so one run must not be able to hide a client span in a server run.
_SIDES = ("client", "server")


@dataclass(frozen=True)
class Target:
    """One conformance directory: where it is, and what it declared."""

    # Path-derived, and stable enough to key a report and a URL on.
    id: str
    path: str
    domain: str
    language: str
    library: str
    instrumentation: str
    side: str | None
    # Declared, and authoritative over anything the path suggests.
    spec: PackageSpec
    directory: Path

    @property
    def runner(self) -> str | None:
        return self.spec.runner


def _facets(relative: Path) -> tuple[str, str, str, str, str | None]:
    """Split a directory under ``scenarios/`` into the layout above."""
    parts = relative.parts
    if len(parts) < 4:
        raise ValueError(
            f"{relative} is not <domain>/<language>/<library>/"
            "<instrumentation>[/<side>]"
        )
    domain, language, library, instrumentation = parts[:4]
    side = parts[4] if len(parts) > 4 and parts[4] in _SIDES else None
    return domain, language, library, instrumentation, side


def discover(root: Path) -> list[Target]:
    """Every conformance directory under ``root`` that has a reduction.

    A directory with a spec but no ``data.json`` has never been run to
    completion, so there is nothing to report about it; it is skipped rather
    than reported as empty coverage, which would read as a failing
    implementation instead of an absent measurement.
    """
    scenarios = root / SCENARIO_ROOT
    found: list[Target] = []
    for spec_file in sorted(scenarios.rglob(SPEC_FILE)):
        directory = spec_file.parent
        if not (directory / DATA_FILE).is_file():
            continue
        relative = directory.relative_to(scenarios)
        domain, language, library, instrumentation, side = _facets(relative)
        found.append(
            Target(
                id=relative.as_posix(),
                path=directory.relative_to(root).as_posix(),
                domain=domain,
                language=language,
                library=library,
                instrumentation=instrumentation,
                side=side,
                spec=load_spec(directory),
                directory=directory,
            )
        )
    return found
