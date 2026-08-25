# `otel-conformance-report`

Joins every committed reduction to what the pinned registry declares, and
writes the report the [site](../../docs) reads.

A `data.json` is a numerator: it records which of a signal's declared
attributes a run carried, and cannot say how many there were to carry. That is
in the coverage model — weaver's resolution of the pinned registry, which is a
cache rather than a committed file. This tool joins the two and commits the
result, so the site needs neither weaver nor a registry.

```sh
uv run otel-conformance-report build    # write docs/data/conformance.json
uv run otel-conformance-report check    # fail if a rebuild would differ
uv run otel-conformance-report markdown # summarise for a job summary
```

`build` is deterministic — sorted keys, sorted sequences, no timestamp — because
`check` gates the committed file byte-for-byte, and because the ecosystem
registry downstream content-addresses what it ingests. A rebuild that only
reorders a list is a failing build.

## How to read the numbers

**There is no single conformance score, on purpose.** A registry declares
attributes at five requirement levels, and an absence is only a gap at two of
them. Blending all five into one percentage produces a number that gets quoted
and is wrong.

| Level | Is an absence a gap? |
| --- | --- |
| `required` | Yes. Scored. |
| `recommended` | Usually. Scored separately, because an instrumentation may have had nothing to put there. |
| `conditionally_required_conditional` | Unknowable from one run — whether the condition held is not in the data. Counted, never scored. |
| `recommended_conditional` | Same. Counted, not scored. |
| `opt_in` | No. Off by default is the correct behaviour. Counted, not scored. |

Only the first two are summed into a target's coverage (`SCORED_LEVELS` in
[`_aggregate.py`](src/conformance_report/_aggregate.py)). The other three are
reported per signal as counts.

Coverage is measured against a pinned registry, so moving a pin changes the
denominator: a newly-required attribute lowers coverage with no instrumentation
having changed. That is correct, and is why the report is regenerated when a pin
moves. Which registry each domain was read against is in `conformance.json`, and
on the site's footer.

## Findings

A finding is one piece of weaver advice at its `violation` level. There is no
severity to rank on — every finding recorded is a violation, and only the id
distinguishes them.

**Most findings are absences, not malformed telemetry.** Weaver records an
attribute the registry requires and the run did not carry as a violation, so the
bulk of them restate a coverage gap rather than describing something the run got
wrong. The two categories are worth keeping apart when reading a target:

| Finding | What it means |
| --- | --- |
| `missing_attribute`, `required_attribute_not_present`, `recommended_attribute_not_present`, `genai_expected_attribute_missing`, `error_type_missing_on_error`, `missing_event`, `missing_metric` | An absence. The same gap the coverage bars show, counted a second way. |
| `type_mismatch`, `unit_mismatch`, `genai_span_name_format`, `span_status_ok_set_by_instrumentation` | Something arrived, and was wrong. |

One case spans both: an attribute that arrives holding a type the registry does
not allow is recorded as a `type_mismatch` finding **and left out of coverage** —
counting it would claim conformance the run did not have. So it can be in the
findings list and absent from the emitted list at once.
