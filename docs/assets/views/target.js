// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import {
  LEVELS,
  LEVEL_LABEL,
  FINDING_LABEL,
  findingKind,
  fullLabel,
  attributeUrl,
} from "../data.js";
import { coverageBar, el, levelBar, palette, trackBand } from "../ui.js";
import { go, targetHref } from "../route.js";

const REPO =
  "https://github.com/open-telemetry/semantic-conventions-conformance";
// Every committed finding is a weaver `violation`; these split them by what
// they say, so the first bucket cannot reuse that word.
const KINDS = {
  violation: "Breaks the convention",
  absent: "Expected, not emitted",
  unregistered: "Emitted, not in the registry",
};
const signalKey = (signal) => `${signal.type}:${signal.name}`;
const compareUrl = (key) => `#/signals/${encodeURIComponent(key)}`;
const groupId = (id) => `finding-${id}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** @param {import('../data.js').Data} data @param {string|null} id */
export function title(data, id) {
  const found = data.byId.get(id);
  return found
    ? `${fullLabel(found)} · conformance`
    : "instrumentations · conformance";
}

/** One instrumentation's coverage, emitted signals and complete findings. */
export default function target(data, id) {
  const found = data.byId.get(id);
  const picker = palette({
    label: "Instrumentation",
    items: data.targets
      .map((target) => ({
        value: target.id,
        name: fullLabel(target),
        group: `${target.domain} · ${target.language}`,
        badge: target.side ?? undefined,
      }))
      .sort(
        (a, b) =>
          a.group.localeCompare(b.group) || a.name.localeCompare(b.name),
      ),
    value: id,
    onPick: (value) => go(targetHref(value).slice(1)),
  });
  const controls = el("div", { class: "controls" }, [
    el("div", { class: "controls-row" }, [
      el("h2", { text: "Instrumentation" }),
      picker.node,
    ]),
  ]);
  trackBand(controls);
  if (!found)
    return el("div", {}, [
      controls,
      id && el("p", { class: "note", text: `No instrumentation called ${id}` }),
    ]);
  const root = el("div", { class: "target-detail" }, [
    controls,
    el("p", { class: "crumbs", text: `${found.domain} / ${found.language}` }),
    el("h2", {
      text: [found.instrumented_library, found.label, found.backend, found.side]
        .filter(Boolean)
        .join(" · "),
    }),
    el("p", { class: "mono", text: found.instrumentation_library }),
    facts(data, found),
    scores(found),
    ...[
      ["span", "Spans"],
      ["metric", "Metrics"],
      ["event", "Events"],
    ].map(([type, label]) => {
      const signals = found.signals
        .filter((signal) => signal.type === type)
        .sort((a, b) => (b.missing?.length ?? 0) - (a.missing?.length ?? 0));
      return (
        signals.length > 0 &&
        el("section", { "aria-label": label }, [
          el("h3", { text: label }),
          ...signals.map((signal) => signalCard(data, found, signal)),
        ])
      );
    }),
    entities(data, found),
    findings(found),
  ]);
  // Fragment-only anchors belong to the router. Keep this jump inside the view.
  root.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-finding]");
    if (!link) return;
    event.preventDefault();
    const group = [...root.querySelectorAll("details[id]")].find(
      (node) => node.id === link.dataset.finding,
    );
    if (group) {
      group.open = true;
      group.scrollIntoView?.({ block: "center" });
      group.querySelector("summary").focus();
    }
  });
  return root;
}

function facts(data, found) {
  const pin = data.report.domains[found.runner];
  const rows = [
    ["Instrumented library", found.instrumented_library],
    ["Instrumentation", found.instrumentation_library],
    ["Domain", `${found.domain} (${found.runner})`],
    ["Language", found.language],
    ["Scenarios exercised", found.scenario_classes.join(", ") || "—"],
    [
      "Registry",
      pin
        ? el("a", {
            href: `https://github.com/${pin.registry_repo}/tree/${pin.registry_ref}/${pin.registry_dir}`,
            rel: "noreferrer",
            text: `${pin.registry_repo} @ ${pin.registry_ref.slice(0, 12)}`,
          })
        : "—",
    ],
    [
      "Source",
      el("a", {
        href: `${REPO}/tree/main/${found.path}`,
        rel: "noreferrer",
        text: found.path,
      }),
    ],
  ];
  const peers = new Set(
    data.targets.filter(
      (target) =>
        target.language === found.language &&
        target.instrumented_library === found.instrumented_library,
    ),
  );
  const common = [...data.signals.values()]
    .map((signal) => ({
      signal,
      shared: signal.rows.filter(({ target }) => peers.has(target)).length,
    }))
    .filter(({ shared }) => shared > 0)
    .sort(
      (a, b) => b.shared - a.shared || a.signal.key.localeCompare(b.signal.key),
    )[0]?.signal;
  if (peers.size > 1 && common)
    rows.push([
      "Same library",
      el("a", {
        href: `${compareUrl(common.key)}?${new URLSearchParams({ lib: found.instrumented_library })}`,
        text: `Compare all instrumentations of ${found.instrumented_library}`,
      }),
    ]);
  return el(
    "dl",
    { class: "facts" },
    rows.flatMap(([label, value]) => [
      el("dt", { text: label }),
      el("dd", {}, value),
    ]),
  );
}

function scores(found) {
  const counts = Object.fromEntries(
    Object.keys(KINDS).map((kind) => [
      kind,
      found.findings.filter((finding) => findingKind(finding.id) === kind)
        .length,
    ]),
  );
  return el("section", { class: "card", "aria-label": "Coverage" }, [
    el("h3", { text: "Coverage" }),
    el("p", {
      class: "ver",
      text: "Summed over every signal this run emitted",
    }),
    el("dl", { class: "facts" }, [
      ...["required", "recommended"].flatMap((level) => [
        el("dt", { text: LEVEL_LABEL[level] }),
        el("dd", {}, coverageBar(found.summary[level], level)),
      ]),
      el("dt", { text: "Findings" }),
      el("dd", {
        class: "finding-counts",
        text: `${counts.violation} breaking the convention · ${counts.absent} expected, not emitted · ${counts.unregistered} not in the registry`,
      }),
    ]),
  ]);
}

function signalCard(data, found, signal) {
  const declaration = data.signals.get(signalKey(signal));
  const attributes = declaration?.attributes ?? {};
  const pin = data.report.domains[found.runner];
  const ownFindings = found.findings.filter(
    (f) => findingKind(f.id) !== "unregistered" && belongsTo(found, f, signal),
  );
  return el("div", { class: "card" }, [
    el("h4", {}, [
      el("span", { class: "mono", text: signal.name }),
      el("span", {
        class: "kind",
        text:
          signal.type === "span"
            ? (signal.identity?.span_kind ?? declaration?.kind)
            : signal.type,
      }),
      el("a", {
        class: "compare",
        href: compareUrl(signalKey(signal)),
        text: "compare across targets →",
      }),
    ]),
    signal.coverage
      ? levelBar(signal.coverage)
      : el("p", {
          class: "note",
          text: "This signal has no declaration in the pinned registry. There is no denominator; its emitted attributes are left uncounted.",
        }),
    ...LEVELS.map((level) => {
      const names = Object.keys(attributes)
        .filter((name) => attributes[name] === level)
        .sort();
      return (
        signal.coverage &&
        names.length > 0 &&
        el("div", { class: "attribute-group", "data-level": level }, [
          el("h5", {
            class: "attr-level",
            text: `${LEVEL_LABEL[level]} (${names.filter((name) => signal.emitted.includes(name)).length}/${names.length})`,
          }),
          el(
            "p",
            { class: "attrs" },
            names.map((name) => {
              const emitted = signal.emitted.includes(name);
              const href = attributeUrl(name, pin);
              return el(href ? "a" : "code", {
                href,
                rel: href ? "noreferrer" : undefined,
                class: emitted ? "emitted" : "missing",
                title: emitted ? "Emitted" : "Not emitted",
                text: name,
              });
            }),
          ),
        ])
      );
    }),
    (() => {
      const extra = signal.emitted.filter(
        (name) => !Object.hasOwn(attributes, name),
      );
      return (
        extra.length > 0 &&
        el("details", { class: "unregistered-attributes" }, [
          el("summary", {
            text: `Emitted, not in the registry (${extra.length})`,
          }),
          attributeList(extra, "emitted"),
        ])
      );
    })(),
    ownFindings.length > 0 &&
      el("p", { class: "signal-findings" }, [
        `${plural(ownFindings.length, "finding")}: `,
        ...[...new Set(ownFindings.map((f) => f.id))].map((id) =>
          el("a", {
            href: targetHref(found.id),
            "data-finding": groupId(id),
            text: `${FINDING_LABEL[id] ?? id} (${ownFindings.filter((f) => f.id === id).length})`,
          }),
        ),
      ]),
  ]);
}

/**
 * Whether a finding was reported on this signal.
 *
 * Metrics and events are named the same on both sides. Spans are not: the
 * signal is the registry's name (`http.server`) and the finding carries the
 * span's own (`GET`), and nothing in the report joins the two. A span finding
 * is only placed when the target emitted a single span; otherwise it stays in
 * the findings list alone rather than being pinned to a guess.
 */
function belongsTo(found, finding, signal) {
  const type = finding.signal_type === "log" ? "event" : finding.signal_type;
  if (type !== signal.type) return false;
  if (finding.signal_name === signal.name) return true;
  return (
    type === "span" &&
    found.signals.filter((other) => other.type === "span").length === 1
  );
}

function attributeList(names, kind) {
  return el(
    "p",
    { class: `attrs ${kind}` },
    names.map((name) => el("code", { text: name })),
  );
}

function findings(found) {
  const groups = new Map();
  for (const finding of found.findings) {
    if (!groups.has(finding.id)) groups.set(finding.id, []);
    groups.get(finding.id).push(finding);
  }
  return el("section", { class: "card findings", "aria-label": "Findings" }, [
    el("h3", { text: "Findings" }),
    !groups.size &&
      el("p", { text: "None. Weaver recorded no findings on this run." }),
    ...Object.entries(KINDS).map(([kind, label]) => {
      const entries = [...groups]
        .filter(([id]) => findingKind(id) === kind)
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
      return (
        entries.length > 0 &&
        el("section", { "data-kind": kind }, [
          el("h4", { text: label }),
          ...entries.map(([id, items]) =>
            el(
              "details",
              {
                id: groupId(id),
                open: kind !== "unregistered" && items.length <= 3,
              },
              [
                el("summary", {}, [
                  FINDING_LABEL[id] ?? id,
                  " ",
                  el("code", { class: "finding-id", text: id }),
                  ` × ${items.length}`,
                ]),
                ...items.map((finding) =>
                  el("div", { class: "finding" }, [
                    el("span", { class: "msg", text: finding.message }),
                    finding.signal_name &&
                      el("span", {
                        class: "where",
                        text: `on ${finding.signal_type} ${finding.signal_name}`,
                      }),
                  ]),
                ),
              ],
            ),
          ),
        ])
      );
    }),
  ]);
}

/**
 * The resource entities the run carried, named rather than counted.
 *
 * A count of the identifying attributes says nothing: the reduction only
 * records an entity when *every* declared identifying attribute was emitted
 * (see `_entities` in the runner's `_semconv`), so that number is a constant
 * per entity name. What varies is the descriptive attributes, and their
 * denominator is the registry's declaration — already in the report, and read
 * by nothing until now.
 */
function entities(data, found) {
  const names = Object.keys(found.entities ?? {});
  if (!names.length) return null;
  const declared = data.report.registry?.[found.runner]?.entities ?? {};

  return el("div", { class: "card" }, [
    el("h4", {}, [
      "Resource entities",
      el("span", {
        class: "kind",
        text: "recognised only when every identifying attribute was present",
      }),
    ]),
    ...names.sort().map((name) => {
      const entity = found.entities[name];
      const description = Object.keys(declared[name]?.description ?? {});
      const carried = new Set(entity.description);
      const absent = description.filter((attribute) => !carried.has(attribute));

      return el("dl", { class: "entity" }, [
        el("dt", {}, [el("span", { class: "mono", text: name })]),
        el("dd", {}, [
          el("span", { class: "entity-role", text: "identified by" }),
          attributeList(entity.identity, "emitted"),
        ]),
        // No declared descriptive attributes — `service.instance` is one —
        // is not the same as having emitted none of them.
        description.length === 0 &&
          el("dd", {}, [
            el("span", { class: "ver", text: "nothing further declared" }),
          ]),
        entity.description.length > 0 &&
          el("dd", {}, [
            el("span", { class: "entity-role", text: "emitted" }),
            attributeList(entity.description, "emitted"),
          ]),
        absent.length > 0 &&
          el("dd", {}, [
            el("span", { class: "entity-role", text: "not emitted" }),
            attributeList(absent, "missing"),
          ]),
      ]);
    }),
  ]);
}
