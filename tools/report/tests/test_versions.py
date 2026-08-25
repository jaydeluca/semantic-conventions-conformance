# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

"""Recovering the release a directory measured, per language.

Every extractor here reads a real shape from this repo rather than an invented
one, so a scenario layout changing under the report shows up as a failing test
instead of a column of nulls on the site.
"""

from __future__ import annotations

from pathlib import Path

from conformance_report._versions import versions

# ---------------------------------------------------------------- python ----


def test_python_reads_the_exact_pins(tmp_path: Path) -> None:
    directory = tmp_path / "openai" / "opentelemetry-openai"
    directory.mkdir(parents=True)
    (directory / "pyproject.toml").write_text(
        """
[project]
name = "openai-opentelemetry-conformance"
version = "0.0.0"
dependencies = [
    "openai==3.3.1",
    "opentelemetry-sdk==1.44.0",
    "opentelemetry-instrumentation-genai-openai==1.1b0",
]
""",
        encoding="utf-8",
    )
    found = versions(
        directory,
        tmp_path,
        "python",
        "opentelemetry-instrumentation-genai-openai",
        "openai",
    )
    assert found.instrumentation == "1.1b0"
    assert found.instrumented == "3.3.1"


def test_python_ignores_a_range(tmp_path: Path) -> None:
    """A range is not a pin, and reporting its floor would be a lie."""
    directory = tmp_path / "a" / "b"
    directory.mkdir(parents=True)
    (directory / "pyproject.toml").write_text(
        '[project]\ndependencies = ["flask >= 3, <4"]\n', encoding="utf-8"
    )
    assert versions(directory, tmp_path, "python", "x", "flask").instrumented is None


def test_python_matches_a_name_the_way_pypi_does(tmp_path: Path) -> None:
    """`Foo_Bar` and `foo-bar` are the same project."""
    directory = tmp_path / "a" / "b"
    directory.mkdir(parents=True)
    (directory / "pyproject.toml").write_text(
        '[project]\ndependencies = ["Google_GenAI==1.2.3"]\n', encoding="utf-8"
    )
    found = versions(directory, tmp_path, "python", "x", "google-genai")
    assert found.instrumented == "1.2.3"


# -------------------------------------------------------------------- js ----


def test_js_reads_the_leaf_and_the_shared_workload(tmp_path: Path) -> None:
    """The instrumentation is in the leaf; the library it wraps is beside it."""
    library = tmp_path / "express"
    (library / "opentelemetry-express").mkdir(parents=True)
    (library / "scenarios").mkdir()
    (library / "opentelemetry-express" / "package.json").write_text(
        """
{"dependencies": {
  "@otel-conformance/express-scenarios": "*",
  "@otel-conformance/scenario-sdk": "file:../../tools/js/scenario-sdk",
  "@opentelemetry/instrumentation-express": "0.69.0"
}}
""",
        encoding="utf-8",
    )
    (library / "scenarios" / "package.json").write_text(
        '{"dependencies": {"express": "5.2.1"}}', encoding="utf-8"
    )
    found = versions(
        library / "opentelemetry-express",
        tmp_path,
        "js",
        "@opentelemetry/instrumentation-express",
        "express",
    )
    assert found.instrumentation == "0.69.0"
    assert found.instrumented == "5.2.1"


def test_js_ignores_a_workspace_link(tmp_path: Path) -> None:
    """`file:` and `*` are links to this checkout, not releases."""
    directory = tmp_path / "a" / "b"
    directory.mkdir(parents=True)
    (directory / "package.json").write_text(
        '{"dependencies": {"@otel/x": "file:../x", "@otel/y": "*"}}',
        encoding="utf-8",
    )
    found = versions(directory, tmp_path, "js", "@otel/x", "@otel/y")
    assert (found.instrumentation, found.instrumented) == (None, None)


# ---------------------------------------------------------------- dotnet ----


def test_dotnet_joins_a_reference_to_central_package_management(
    tmp_path: Path,
) -> None:
    """A project names the package; the version is up the tree."""
    (tmp_path / "Directory.Packages.props").write_text(
        """
<Project><ItemGroup>
  <PackageVersion Include="OpenTelemetry.Instrumentation.AspNetCore" Version="1.17.0" />
  <PackageVersion Include="OpenTelemetry.Instrumentation.Http" Version="1.17.0" />
</ItemGroup></Project>
""",
        encoding="utf-8",
    )
    directory = tmp_path / "aspnetcore" / "opentelemetry-aspnetcore"
    directory.mkdir(parents=True)
    (directory / "Server.csproj").write_text(
        '<Project><ItemGroup><PackageReference Include='
        '"OpenTelemetry.Instrumentation.AspNetCore" /></ItemGroup></Project>',
        encoding="utf-8",
    )
    found = versions(
        directory,
        tmp_path,
        "dotnet",
        "OpenTelemetry.Instrumentation.AspNetCore",
        "Microsoft.AspNetCore",
    )
    assert found.instrumentation == "1.17.0"
    # Part of the framework, so there is no package pinning it. Null is right.
    assert found.instrumented is None


def test_dotnet_stops_at_the_root(tmp_path: Path) -> None:
    """Walking up must not escape the checkout it was given."""
    (tmp_path.parent / "Directory.Packages.props").write_text(
        '<Project><ItemGroup><PackageVersion Include="X" Version="9.9.9" />'
        "</ItemGroup></Project>",
        encoding="utf-8",
    )
    directory = tmp_path / "a" / "b"
    directory.mkdir(parents=True)
    assert versions(directory, tmp_path, "dotnet", "X", "y").instrumentation is None


# ------------------------------------------------------------------ java ----

CATALOG = """
[versions]
okhttp = "4.12.0"
akka-http = "10.2.10"
armeria = "1.41.0"
opentelemetry-instrumentation = "2.31.1"
opentelemetry-instrumentation-alpha = "2.31.1-alpha"

[libraries]
okhttp = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }
akka-http = { module = "com.typesafe.akka:akka-http_2.13", version.ref = "akka-http" }
armeria = { module = "com.linecorp.armeria:armeria", version.ref = "armeria" }
opentelemetry-instrumentation-bom-alpha = { module = "io.opentelemetry.instrumentation:opentelemetry-instrumentation-bom-alpha", version.ref = "opentelemetry-instrumentation-alpha" }
opentelemetry-instrumentation-armeria = { module = "io.opentelemetry.instrumentation:opentelemetry-armeria-1.3" }
opentelemetry-javaagent = { module = "io.opentelemetry.javaagent:opentelemetry-javaagent", version.ref = "opentelemetry-instrumentation" }
"""


def java_tree(root: Path, library: str, instrumentation: str) -> Path:
    (root / "gradle").mkdir(parents=True, exist_ok=True)
    (root / "gradle" / "libs.versions.toml").write_text(
        CATALOG, encoding="utf-8"
    )
    leaf = root / library / instrumentation
    leaf.mkdir(parents=True)
    (root / library / "scenarios").mkdir(exist_ok=True)
    return leaf


def test_java_resolves_a_catalog_alias(tmp_path: Path) -> None:
    leaf = java_tree(tmp_path, "okhttp", "opentelemetry-javaagent")
    (leaf / "build.gradle.kts").write_text(
        'dependencies { add("javaAgent", libs.opentelemetry.javaagent) }',
        encoding="utf-8",
    )
    (tmp_path / "okhttp" / "scenarios" / "build.gradle.kts").write_text(
        "dependencies { api(libs.okhttp) }", encoding="utf-8"
    )
    found = versions(
        leaf,
        tmp_path,
        "java",
        "io.opentelemetry.javaagent:opentelemetry-javaagent",
        "okhttp",
    )
    assert found.instrumentation == "2.31.1"
    # Pinned in the shared workload beside the leaf, never in the leaf itself.
    assert found.instrumented == "4.12.0"


def test_java_resolves_a_versionless_entry_through_its_bom(
    tmp_path: Path,
) -> None:
    """The catalog pins the group once; its artifacts are that release."""
    leaf = java_tree(tmp_path, "armeria", "opentelemetry-library")
    (leaf / "build.gradle.kts").write_text(
        "dependencies { implementation(libs.opentelemetry.instrumentation.armeria) }",
        encoding="utf-8",
    )
    found = versions(
        leaf,
        tmp_path,
        "java",
        "io.opentelemetry.instrumentation:opentelemetry-armeria-1.3",
        "armeria",
    )
    assert found.instrumentation == "2.31.1-alpha"


def test_java_strips_a_scala_cross_version(tmp_path: Path) -> None:
    """`akka-http_2.13` is the artifact for akka-http, one per compiler."""
    leaf = java_tree(tmp_path, "akka-http", "opentelemetry-javaagent")
    (leaf / "build.gradle.kts").write_text(
        "dependencies { implementation(libs.akka.http) }", encoding="utf-8"
    )
    found = versions(leaf, tmp_path, "java", "x:y", "akka-http")
    assert found.instrumented == "10.2.10"


def test_java_does_not_guess_when_the_label_is_not_the_artifact(
    tmp_path: Path,
) -> None:
    """`servlet` is pinned as tomcat-embed-core; null beats a wrong version."""
    leaf = java_tree(tmp_path, "servlet", "opentelemetry-javaagent")
    (leaf / "build.gradle.kts").write_text(
        "dependencies { implementation(libs.armeria) }", encoding="utf-8"
    )
    assert versions(leaf, tmp_path, "java", "x:y", "servlet").instrumented is None


# --------------------------------------------------------------- general ----


def test_an_unknown_language_is_not_an_error(tmp_path: Path) -> None:
    """A new language should add a column of nulls, not break the build."""
    found = versions(tmp_path, tmp_path, "ruby", "a", "b")
    assert (found.instrumentation, found.instrumented) == (None, None)


def test_a_directory_with_nothing_to_read_is_not_an_error(
    tmp_path: Path,
) -> None:
    found = versions(tmp_path, tmp_path, "python", "a", "b")
    assert found.as_dict() == {"instrumentation": None, "instrumented": None}
