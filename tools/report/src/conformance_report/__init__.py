# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

"""One report over every committed conformance reduction in a checkout.

The runner records what one directory emitted. This records what all of them
did, joined to what the pinned registries declare, so the questions the
individual files cannot answer — which declared attribute nobody emits, which
of two instrumentations of one library covers more of it, what moved since
last week — have somewhere to be asked.

The output is a single committed JSON document, deliberately shaped so it can
be read by more than the page in ``docs/``. See ``README.md``.
"""

from ._aggregate import SCHEMA_VERSION, build, render, signal_coverage
from ._discover import Target, discover
from ._versions import Versions

__all__ = [
    "SCHEMA_VERSION",
    "Target",
    "Versions",
    "build",
    "discover",
    "render",
    "signal_coverage",
]
