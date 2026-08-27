# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

"""One report over every committed conformance reduction in a checkout.

The runner records what one directory emitted. This records what all of them
did, joined to what the pinned registries declare, so the questions the
individual files cannot answer — which declared attribute nobody emits, which
of two instrumentations of one library covers more of it — have somewhere to
be asked.

The output is a single committed JSON document, deliberately shaped so it can
be read by more than the page in ``docs/``. See ``README.md``.
"""

from ._aggregate import SCHEMA_VERSION, build, render, signal_coverage
from ._cli import cli
from ._discover import Target, discover

__all__ = [
    "SCHEMA_VERSION",
    "Target",
    "build",
    "cli",
    "discover",
    "render",
    "signal_coverage",
]
