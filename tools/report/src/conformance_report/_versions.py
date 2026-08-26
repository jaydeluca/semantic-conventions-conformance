# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

"""Which release a directory measured, read from what it already pins.

A data file records what a run emitted, not what emitted it, so the version is
recovered rather than reported. That is safe here only because every scenario
pins exactly — ``==`` in a ``pyproject.toml``, an exact string in a
``package.json``, a ``PackageVersion`` in central package management, a Gradle
version catalog — so a pin resolves to one release and reading it needs no
resolver and no network.

Each language keeps its pins somewhere else, so there is an extractor per
language and no attempt at a general one. Failure is always ``None``: a
version is a label on a measurement, and a report missing one is worth more
than a report that refuses to build.
"""

from __future__ import annotations

import json
import re
import tomllib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Mapping, cast


def _toml(path: Path) -> dict[str, Any]:
    """A TOML file as a plain document.

    Annotated at the boundary on purpose: everything below reads pins out of
    nested `Any`, and without one type here that unknown propagates through
    every extractor.
    """
    return tomllib.loads(path.read_text(encoding="utf-8"))


def _table(document: Mapping[str, Any], name: str) -> dict[str, Any]:
    """One table of a document, or an empty one."""
    found = document.get(name)
    return cast("dict[str, Any]", found) if isinstance(found, dict) else {}


# `name==1.2.3`, the only form these scenarios use; anything looser is not a
# pin and is deliberately not matched.
_PYTHON_PIN = re.compile(r"^\s*([A-Za-z0-9._-]+)\s*==\s*([^\s;]+)")

# Central package management, and the reference that selects from it.
_PACKAGE_VERSION = re.compile(
    r'<PackageVersion\s+Include="([^"]+)"\s+Version="([^"]+)"'
)
_PACKAGE_REFERENCE = re.compile(r'<PackageReference\s+Include="([^"]+)"')

# `libs.opentelemetry.javaagent` — a catalog alias as Gradle spells it in a
# build script, where the alias' own hyphens have become dots.
_CATALOG_ACCESSOR = re.compile(r"\blibs\.([a-z0-9]+(?:\.[a-z0-9]+)*)\b")


@dataclass(frozen=True)
class Versions:
    """The two releases a measurement is about."""

    # The instrumentation whose conformance is being measured.
    instrumentation: str | None = None
    # The library it instruments, which decides what there was to instrument.
    instrumented: str | None = None

    def as_dict(self) -> dict[str, str | None]:
        return {
            "instrumentation": self.instrumentation,
            "instrumented": self.instrumented,
        }


def _workload_dirs(directory: Path) -> list[Path]:
    """Where a scenario's own pins and its shared workload's pins live.

    Both java and js put the instrumentation in the leaf and the library it
    instruments in a ``scenarios/`` directory beside it, shared by every
    instrumentation of that library — ``okhttp/scenarios`` pins okhttp, while
    ``okhttp/opentelemetry-javaagent`` pins the agent. So the instrumented
    library's version is never in the directory that was measured, and the
    sibling has to be read to find it.
    """
    found = [directory]
    for parent in (directory.parent, directory.parent.parent):
        shared = parent / "scenarios"
        if shared.is_dir() and shared != directory:
            found.append(shared)
        found.append(parent)
    # Nearest first, without repeats: an inner pin wins over an outer one.
    seen: set[Path] = set()
    return [p for p in found if not (p in seen or seen.add(p))]


def _same_name(left: str, right: str) -> bool:
    """Whether two spellings name the same package.

    Package names are case-insensitive and punctuation-insensitive on PyPI and
    NuGet both, and a scenario spells a library the way its own docs do rather
    than the way its index normalises it.
    """

    def key(value: str) -> str:
        return re.sub(r"[-_.]+", "-", value).casefold()

    if key(left) == key(right):
        return True
    # Scala publishes one artifact per compiler version, so the coordinate
    # carries a suffix the library's own name does not: `akka-http_2.13` is
    # akka-http. Only stripped from the coordinate side, never from the label.
    return key(re.sub(r"_\d+\.\d+$", "", left)) == key(right)


def _match(pins: Mapping[str, str], name: str) -> str | None:
    """The pin for ``name``, if one of them is it."""
    return next(
        (
            version
            for pinned, version in pins.items()
            if _same_name(pinned, name)
        ),
        None,
    )


# --- python ----------------------------------------------------------------


def _python(directory: Path, root: Path) -> Mapping[str, str]:
    """Exact pins from the ``pyproject.toml`` a scenario runs ``--project``."""
    del root
    path = directory / "pyproject.toml"
    if not path.is_file():
        return {}
    dependencies = _table(_toml(path), "project").get("dependencies")
    if not isinstance(dependencies, list):
        return {}
    pins: dict[str, str] = {}
    for entry in cast("list[object]", dependencies):
        if not isinstance(entry, str):
            continue
        found = _PYTHON_PIN.match(entry)
        if found:
            pins[found.group(1)] = found.group(2)
    return pins


# --- javascript ------------------------------------------------------------


def _js(directory: Path, root: Path) -> Mapping[str, str]:
    """Exact versions from the workspace package that installs the build.

    The ``package.json`` naming the instrumentation is the one beside the
    launcher, which is a directory above a ``client/``or ``server/`` spec.
    """
    del root
    pins: dict[str, str] = {}
    for candidate in _workload_dirs(directory):
        path = candidate / "package.json"
        if not path.is_file():
            continue
        document = cast(
            "dict[str, object]", json.loads(path.read_text(encoding="utf-8"))
        )
        dependencies = document.get("dependencies")
        if not isinstance(dependencies, dict):
            continue
        for name, version in cast(
            "dict[object, object]", dependencies
        ).items():
            # A workspace or path dependency is a link, not a release.
            if (
                isinstance(name, str)
                and isinstance(version, str)
                and re.match(r"^\d", version)
            ):
                pins.setdefault(name, version)
    return pins


# --- dotnet ----------------------------------------------------------------


def _dotnet(directory: Path, root: Path) -> Mapping[str, str]:
    """Versions from central package management, up the build tree.

    A project references a package by name only; the version comes from the
    nearest ``Directory.Packages.props`` above it. Walking up rather than
    naming the domain's build root keeps this working for a second domain.
    """
    pins: dict[str, str] = {}
    for parent in (directory, *directory.parents):
        props = parent / "Directory.Packages.props"
        if props.is_file():
            for name, version in _PACKAGE_VERSION.findall(
                props.read_text(encoding="utf-8")
            ):
                # Nearest wins: an inner tree may re-pin what an outer one set.
                pins.setdefault(name, version)
        if parent == root:
            break
    return pins


# --- java ------------------------------------------------------------------


@lru_cache(maxsize=None)
def _catalog(path: Path) -> tuple[Mapping[str, str], Mapping[str, str]]:
    """A Gradle version catalog, as ``(alias -> module, alias -> version)``.

    Cached on the file: one catalog serves every scenario in its build, and
    there are 29 of them in the java tree alone.
    """
    document = _toml(path)
    versions = {
        alias: value
        for alias, value in _table(document, "versions").items()
        if isinstance(value, str)
    }
    modules: dict[str, str] = {}
    resolved: dict[str, str] = {}
    for alias, entry in _table(document, "libraries").items():
        if not isinstance(entry, dict):
            continue
        table = cast("dict[str, Any]", entry)
        module = table.get("module")
        if isinstance(module, str):
            modules[alias] = module
        version = table.get("version")
        if isinstance(version, str):
            resolved[alias] = version
        elif isinstance(version, dict):
            reference = cast("dict[str, Any]", version).get("ref")
            if isinstance(reference, str) and reference in versions:
                resolved[alias] = versions[reference]
    return modules, resolved


def _from_bom(
    module: str,
    modules: Mapping[str, str],
    resolved: Mapping[str, str],
) -> str | None:
    """The version a catalog entry with none of its own gets from a BOM.

    A catalog may pin a group once through its BOM and then list that group's
    artifacts without versions — which is what makes them one release rather
    than several. The catalog says so in as many words for the instrumentation
    group: *"the agent and the instrumentation BOM are one release, published
    under two coordinates, so these two move together."* Reading the group's
    BOM back is how that intent is recovered.

    Matched on the BOM's own coordinate rather than on its alias: an alias is
    whatever the catalog author typed, while the group is what actually decides
    whether a BOM governs an artifact.
    """
    group = module.partition(":")[0]
    for alias, coordinate in modules.items():
        artifact = coordinate.rpartition(":")[2]
        if coordinate.partition(":")[0] != group or "bom" not in artifact:
            continue
        version = resolved.get(alias)
        if version:
            # A BOM may be published as `-alpha`; the artifacts it governs are
            # that release, so the qualifier goes with it.
            return version
    return None


def _java(directory: Path, root: Path) -> Mapping[str, str]:
    """Catalog entries the build scripts around a scenario actually select.

    A build script names an alias (``libs.opentelemetry.javaagent``); the
    catalog turns that into a module and a version. Keying the result by module
    rather than by alias is what lets the caller look a coordinate up.
    """
    catalog: Path | None = None
    for parent in (directory, *directory.parents):
        candidate = parent / "gradle" / "libs.versions.toml"
        if candidate.is_file():
            catalog = candidate
            break
        if parent == root:
            break
    if catalog is None:
        return {}

    modules, resolved = _catalog(catalog)
    pins: dict[str, str] = {}
    for candidate in _workload_dirs(directory):
        script = candidate / "build.gradle.kts"
        if not script.is_file():
            continue
        text = script.read_text(encoding="utf-8")
        for accessor in _CATALOG_ACCESSOR.findall(text):
            # Gradle spells a hyphenated alias with dots; either could be the
            # real alias, so try the accessor as written first.
            for alias in (accessor, accessor.replace(".", "-")):
                module = modules.get(alias)
                if module is None:
                    continue
                version = resolved.get(alias) or _from_bom(
                    module, modules, resolved
                )
                if version:
                    pins.setdefault(module, version)
                break
    return pins


_EXTRACTORS: Mapping[str, Callable[[Path, Path], Mapping[str, str]]] = {
    "python": _python,
    "js": _js,
    "dotnet": _dotnet,
    "java": _java,
}


def _dotnet_referenced(directory: Path) -> set[str]:
    """Package names the projects around a .NET scenario reference by name."""
    referenced: set[str] = set()
    for parent in (directory, directory.parent):
        for project in sorted(parent.glob("*.csproj")):
            referenced.update(
                _PACKAGE_REFERENCE.findall(project.read_text(encoding="utf-8"))
            )
    return referenced


def versions(
    directory: Path,
    root: Path,
    language: str,
    instrumentation_library: str,
    instrumented_library: str,
) -> Versions:
    """The two releases ``directory`` pinned, as far as they can be read.

    ``instrumentation_library`` is already the ecosystem's own coordinate — a
    Maven ``group:artifact``, an npm scope, a NuGet id, a PyPI name — so it is
    looked up directly. ``instrumented_library`` is a label rather than a
    coordinate, so it is matched loosely and often not at all: ``bedrock`` is
    pinned as ``boto3``, and no amount of string work turns one into the
    other.
    """
    extract = _EXTRACTORS.get(language)
    if extract is None:
        return Versions()
    pins = extract(directory, root)
    if not pins:
        return Versions()

    instrumentation = _match(pins, instrumentation_library)
    if instrumentation is None and language == "dotnet":
        # Central package management pins every package the tree may use, so
        # narrow to the ones this scenario's projects actually reference.
        for name in sorted(_dotnet_referenced(directory)):
            if _same_name(name, instrumentation_library):
                instrumentation = pins.get(name)
                break

    instrumented = _match(pins, instrumented_library)
    if instrumented is None:
        # A java coordinate ends in the artifact, which is what the label is
        # usually a form of: `com.squareup.okhttp3:okhttp` for `okhttp`.
        for coordinate, version in pins.items():
            if _same_name(coordinate.rpartition(":")[2], instrumented_library):
                instrumented = version
                break

    return Versions(instrumentation=instrumentation, instrumented=instrumented)
