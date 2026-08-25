# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

"""``otel-conformance-report`` — build the report, or check the committed one.

Four verbs, because the report is used four ways: written, verified in CI,
extended with the time axis at publish time, and summarised for a human
reading a pull request.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Sequence

from opentelemetry.conformance import domain as load_domain

from . import _aggregate, _discover, _history, _markdown

# Where the committed report lives, and where the site reads it from. One
# default in one place: the workflow, the checker and the page must agree or
# the page loads a report nothing gated.
DEFAULT_REPORT = Path("docs/data/conformance.json")
DEFAULT_HISTORY = Path("docs/data/history.json")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="otel-conformance-report",
        description=(
            "Aggregate the committed conformance coverage into one report."
        ),
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=Path.cwd(),
        help="the checkout to read scenarios from (default: cwd)",
    )
    verbs = parser.add_subparsers(dest="verb", required=True)

    build = verbs.add_parser("build", help="write the report")
    build.add_argument("--out", type=Path, default=DEFAULT_REPORT)

    verbs.add_parser(
        "check",
        help="fail if the committed report is not what a rebuild produces",
    )

    history = verbs.add_parser(
        "history", help="replay the report's git history onto a time axis"
    )
    history.add_argument("--out", type=Path, default=DEFAULT_HISTORY)
    history.add_argument(
        "--limit", type=int, default=_history.DEFAULT_LIMIT
    )

    markdown = verbs.add_parser(
        "markdown", help="summarise the report for a job summary"
    )
    markdown.add_argument(
        "--against",
        type=Path,
        help=(
            "a report to diff against, so the summary says what moved rather "
            "than only where things stand"
        ),
    )
    return parser


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def cli(argv: Sequence[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    root: Path = arguments.root.resolve()

    if arguments.verb == "build":
        content = _aggregate.render(_aggregate.build(root))
        out: Path = arguments.out
        _write(out if out.is_absolute() else root / out, content)
        return 0

    if arguments.verb == "check":
        expected = _aggregate.render(_aggregate.build(root))
        committed = root / DEFAULT_REPORT
        if not committed.is_file():
            print(
                f"{DEFAULT_REPORT} is missing — run "
                "`otel-conformance-report build`",
                file=sys.stderr,
            )
            return 1
        if committed.read_text(encoding="utf-8") != expected:
            print(
                f"{DEFAULT_REPORT} is out of date — run "
                "`otel-conformance-report build` and commit the result",
                file=sys.stderr,
            )
            return 1
        return 0

    if arguments.verb == "history":
        # The current build resolves the coverage models the replay scores
        # against, and says which runner each domain directory belongs to.
        targets = _discover.discover(root)
        models = {
            domain: found.coverage_model
            for domain, runner in _history.models_for(targets).items()
            if (found := load_domain(runner)) is not None
        }
        document = _history.build(root, models, limit=arguments.limit)
        out = arguments.out
        _write(
            out if out.is_absolute() else root / out,
            _history.render(document),
        )
        return 0

    document = _aggregate.build(root)
    summary = _markdown.render(document)
    if arguments.against is not None:
        before = json.loads(
            arguments.against.read_text(encoding="utf-8")
        )
        changes = _markdown.render_diff(before, document)
        if changes:
            summary = f"{summary}\n{changes}"
    print(summary, end="")
    return 0


def main() -> None:  # pragma: no cover - the console-script shim
    raise SystemExit(cli())
