// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import {
  LEVELS,
  LEVEL_LABEL,
  FINDING_LABEL,
  findingKind,
  fullLabel,
  attributeUrl,
  levelColor,
  ratio,
} from "../data.js";
import {
  coverageBar,
  el,
  levelBar,
  levelLegend,
  palette,
  trackBand,
} from "../ui.js";
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
const TYPES = ["span", "metric", "event"];
// The two lists that run to dozens on a GenAI target, and that are rarely
// what a reader came for: past this many rows the rest wait behind a button.
const FOLD = { recommended: 6, unregistered: 5 };
// Past this many signals a row's chips are a wall; they fold into a count.
const WHERE_FOLD = 5;
const signalKey = (signal) => `${signal.type}:${signal.name}`;
const compareUrl = (key) => `#/signals/${encodeURIComponent(key)}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const rank = (level) => {
  const index = LEVELS.indexOf(level);
  return index === -1 ? LEVELS.length : index;
};

/** @param {import('../data.js').Data} data @param {string|null} id */
export function title(data, id) {
  const found = data.byId.get(id);
  return found
    ? `${fullLabel(found)} · conformance`
    : "instrumentations · conformance";
}

/**
 * One instrumentation: a verdict, what to fix, then every signal it emitted.
 *
 * @param {import('../data.js').Data} data the indexed report
 * @param {string|null} id the target's id, from the route
 * @returns {HTMLElement}
 */
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
  const view = model(data, found);
  const root = el("div", { class: "target-detail" }, [
    controls,
    header(data, found),
    coverage(view),
    attention(view),
    signalTable(view),
    entities(data, found),
  ]);
  // A where-chip is a button rather than a fragment link: fragment-only
  // anchors belong to the router, and this jump has to stay inside the view.
  root.addEventListener("click", (event) => {
    const chip = event.target.closest("button[data-opens]");
    if (!chip) return;
    const row = [...root.querySelectorAll("tr[data-signal]")].find(
      (node) => node.dataset.signal === chip.dataset.opens,
    );
    if (!row) return;
    expand(row, true);
    row.scrollIntoView?.({ block: "center" });
    row.querySelector(".row-toggle").focus();
  });
  return root;
}

/**
 * Everything the page draws, derived once so the verdict, the fix list and the
 * table cannot disagree about a count.
 *
 * Weaver repeats a finding once per signal, and once per span on the larger
 * runs, so findings are grouped by rule and attribute (or by message, for rules
 * that name none). The fix list then folds absences weaver reported into the
 * coverage rows for the same attribute rather than listing them twice; every
 * finding still lands in exactly one row, and each row says how many.
 */
function model(data, found) {
  const pin = data.report.domains[found.runner];
  const signals = found.signals.map((signal) => {
    const key = signalKey(signal);
    const declaration = data.signals.get(key);
    const levels = declaration?.attributes ?? {};
    const emitted = new Set(signal.emitted);
    const declared = Object.keys(levels).sort(
      (a, b) => rank(levels[a]) - rank(levels[b]) || a.localeCompare(b),
    );
    const missing = declared.filter((name) => !emitted.has(name));
    return {
      signal,
      key,
      levels,
      kind:
        signal.type === "span"
          ? (signal.identity?.span_kind ?? declaration?.kind ?? "span")
          : signal.type,
      emitted: declared.filter((name) => emitted.has(name)),
      missing,
      extra: signal.emitted
        .filter((name) => !Object.hasOwn(levels, name))
        .sort(),
      requiredMissing: missing.filter((name) => levels[name] === "required")
        .length,
      groups: new Set(),
    };
  });

  const byKey = new Map();
  for (const finding of found.findings) {
    const attribute = finding.context?.attribute_key ?? null;
    const key = `${finding.id}\u0000${attribute ?? finding.message}`;
    if (!byKey.has(key))
      byKey.set(key, {
        id: finding.id,
        kind: findingKind(finding.id),
        attribute,
        message: finding.message,
        count: 0,
        where: new Map(),
      });
    const group = byKey.get(key);
    group.count++;
    const owner = signals.find((s) => belongsTo(found, finding, s.signal));
    owner?.groups.add(group);
    const label = finding.signal_name ?? finding.signal_type ?? "resource";
    if (!group.where.get(label)) group.where.set(label, owner?.key ?? null);
  }
  const grouped = [...byKey.values()].sort(
    (a, b) =>
      b.where.size - a.where.size ||
      b.count - a.count ||
      a.id.localeCompare(b.id) ||
      (a.attribute ?? a.message).localeCompare(b.attribute ?? b.message),
  );

  // Rolled up per attribute, and the strictest level wins: one attribute can
  // be required on one metric and only conditionally required on its sibling,
  // and letting the first signal decide would make the required miss vanish.
  const missed = (levels) => {
    const rows = new Map();
    for (const s of signals) {
      for (const name of s.missing) {
        const level = s.levels[name];
        if (!levels.includes(level)) continue;
        if (!rows.has(name))
          rows.set(name, {
            attribute: name,
            level,
            where: new Map(),
            count: 0,
          });
        const row = rows.get(name);
        if (rank(level) < rank(row.level)) row.level = level;
        row.where.set(s.signal.name, s.key);
      }
    }
    return rows;
  };
  const required = missed(["required", "conditionally_required_conditional"]);
  const recommended = missed(["recommended", "recommended_conditional"]);
  const violations = grouped.filter((g) => g.kind === "violation");
  const absent = grouped.filter((g) => g.kind === "absent");
  const unregistered = grouped.filter((g) => g.kind === "unregistered");
  const expected = [];
  for (const group of absent) {
    const row =
      required.get(group.attribute) ?? recommended.get(group.attribute);
    if (row) row.count += group.count;
    else expected.push(group);
  }
  const sorted = (rows) =>
    [...rows.values()].sort(
      (a, b) =>
        rank(a.level) - rank(b.level) ||
        b.where.size - a.where.size ||
        a.attribute.localeCompare(b.attribute),
    );

  return {
    found,
    pin,
    signals,
    grouped,
    required: sorted(required),
    violations,
    absent,
    expected,
    recommended: sorted(recommended),
    unregistered,
  };
}

/**
 * Whether a finding was reported on this signal.
 *
 * Metrics and events are named the same on both sides. Spans are not: the
 * signal is the registry's name (`http.server`) and the finding carries the
 * span's own (`GET`), and nothing in the report joins the two. A span finding
 * is only placed when the target emitted a single span; otherwise it stays in
 * the fix list alone rather than being pinned to a guess.
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

function header(data, found) {
  const pin = data.report.domains[found.runner];
  const peers = new Set(
    data.targets.filter(
      (target) =>
        target.language === found.language &&
        target.instrumented_library === found.instrumented_library,
    ),
  );
  // The signal most of the peers emit, so the comparison opens on a page
  // where they can all be seen side by side.
  const common = [...data.signals.values()]
    .map((signal) => ({
      signal,
      shared: signal.rows.filter(({ target }) => peers.has(target)).length,
    }))
    .filter(({ shared }) => shared > 0)
    .sort(
      (a, b) => b.shared - a.shared || a.signal.key.localeCompare(b.signal.key),
    )[0]?.signal;
  const labelled = (label, value) =>
    el("span", {}, [el("b", { text: label }), value]);

  return el("header", { class: "target-head" }, [
    el("p", { class: "crumbs" }, [
      `${found.domain} / ${found.language}`,
      found.side && el("span", { class: "badge", text: found.side }),
    ]),
    el("h2", {
      text: [found.instrumented_library, found.label, found.backend, found.side]
        .filter(Boolean)
        .join(" · "),
    }),
    el("p", { class: "meta" }, [
      el("span", { class: "mono", text: found.instrumentation_library }),
      pin &&
        labelled(
          "Registry",
          el("a", {
            href: `https://github.com/${pin.registry_repo}/tree/${pin.registry_ref}/${pin.registry_dir}`,
            rel: "noreferrer",
            text: `${pin.registry_repo} @ ${pin.registry_ref.slice(0, 12)}`,
          }),
        ),
      found.scenario_classes.length > 0 &&
        labelled("Scenarios", found.scenario_classes.join(", ")),
      el("a", {
        href: `${REPO}/tree/main/${found.path}`,
        rel: "noreferrer",
        text: "Scenario source",
      }),
      peers.size > 1 &&
        common &&
        el("a", {
          href: `${compareUrl(common.key)}?${new URLSearchParams({ lib: found.instrumented_library })}`,
          text: `Compare all instrumentations of ${found.instrumented_library}`,
        }),
    ]),
  ]);
}

/** The verdict sentence, and the four numbers it is made of. */
function coverage(view) {
  const { found, signals, grouped, violations, recommended, unregistered } =
    view;
  const { summary } = found;
  // A conditional miss may be legitimately absent for the scenario, so only a
  // plain required one counts against the run.
  const hard = view.required.filter((row) => row.level === "required").length;
  // Coverage is a union of observations. An attribute can be present there
  // and still be missing on another observation. Reported absences are
  // violation findings, even when the fix list folds them into coverage rows.
  const absences = view.absent.length;
  const ok = hard === 0 && violations.length === 0 && absences === 0;
  const assessed = signals.some((s) => s.signal.coverage);
  // "Fully" is kept for a run with nothing at all under Needs attention: a
  // conditional miss does not fail the run, but calling
  // it fully conformant right above a list of them reads as a contradiction.
  const leftover =
    view.required.length ||
    view.expected.length ||
    recommended.length ||
    unregistered.length;
  const lead = !assessed
    ? "No coverage assessed: nothing here matched a registry declaration."
    : ok
      ? leftover
        ? "Meets every required attribute and breaks no rule."
        : "Fully conformant on this run."
      : [
          hard && `${plural(hard, "required attribute")} not emitted`,
          violations.length &&
            `${plural(violations.length, "convention rule")} broken`,
          absences && `${plural(absences, "absence finding")} reported`,
        ]
          .filter(Boolean)
          .join(", ") + ".";
  const sub = [
    (summary.required.declared || summary.recommended.declared) &&
      `${summary.required.emitted}/${summary.required.declared} required and ` +
        `${summary.recommended.emitted}/${summary.recommended.declared} recommended ` +
        `attributes emitted across ${plural(signals.length, "signal")}.`,
    unregistered.length &&
      `${plural(unregistered.length, "name")} emitted that the registry doesn't define.`,
  ]
    .filter(Boolean)
    .join(" ");
  const good = ok && assessed;

  const counts = {
    violation: violations.length,
    absent: absences,
    unregistered: unregistered.length,
  };
  const levelTile = (level) => {
    const value = ratio(summary[level]);
    return tile(`${LEVEL_LABEL[level]} attributes`, [
      el("span", { class: "tile-big" }, [
        value === null ? "n/a" : `${Math.round(value * 100)}%`,
        value !== null &&
          el("small", {
            text: ` ${summary[level].emitted} of ${summary[level].declared}`,
          }),
      ]),
      coverageBar(summary[level], level),
    ]);
  };

  return el("section", { class: "scorecard", "aria-label": "Coverage" }, [
    el("div", { class: "verdict" }, [
      el("span", {
        class: `verdict-mark ${good ? "good" : "bad"}`,
        "aria-hidden": "true",
        text: good ? "✓" : "!",
      }),
      el("div", {}, [
        el("p", { class: "verdict-lead", text: lead }),
        sub && el("p", { class: "verdict-sub", text: sub }),
      ]),
    ]),
    el("div", { class: "tiles" }, [
      levelTile("required"),
      levelTile("recommended"),
      tile("Distinct findings", [
        el("span", { class: "tile-big" }, [
          String(grouped.length),
          el("small", {
            text: ` from ${plural(found.findings.length, "report")}`,
          }),
        ]),
        el(
          "p",
          { class: "tile-sub" },
          Object.entries(KINDS).map(([kind, label]) =>
            el("span", {}, [
              el("b", { class: `k-${kind}`, text: String(counts[kind]) }),
              ` ${label.toLowerCase()}`,
            ]),
          ),
        ),
      ]),
      tile("Signals emitted", [
        el("span", { class: "tile-big", text: String(signals.length) }),
        el(
          "p",
          { class: "tile-sub" },
          TYPES.map((type) => {
            const count = signals.filter((s) => s.signal.type === type).length;
            return count > 0 && el("span", { text: plural(count, type) });
          }),
        ),
      ]),
    ]),
  ]);
}

function tile(label, children) {
  return el("div", { class: "tile" }, [
    el("span", { class: "tile-label", text: label }),
    ...children,
  ]);
}

/** What to fix, most serious first; each row is one thing to change. */
function attention(view) {
  const { pin } = view;
  const missRow = (row) => ({
    attribute: row.attribute,
    note: [levelDot(row.level), LEVEL_LABEL[row.level] ?? row.level],
    message: `Not emitted on ${plural(row.where.size, "signal")} that declare${row.where.size === 1 ? "s" : ""} it.`,
    count: row.count,
    where: row.where,
  });
  const sections = [
    [
      "Required attributes not emitted",
      "Declared required or conditionally required on a signal this run emitted. Conditional ones may be legitimately absent for the scenario.",
      view.required.map(missRow),
    ],
    [KINDS.violation, null, view.violations.map(groupRow)],
    [
      KINDS.absent,
      "Absences weaver's advice policies reported that aren't already listed above.",
      view.expected.map(groupRow),
    ],
    [
      "Recommended attributes not emitted",
      null,
      view.recommended.map(missRow),
      FOLD.recommended,
    ],
    [
      "Not in the registry",
      "Names this run emitted that the pinned registry doesn't define. Often vendor or framework extras.",
      view.unregistered.map(groupRow),
      FOLD.unregistered,
    ],
  ].filter(([, , rows]) => rows.length > 0);
  if (!sections.length) return null;

  return el(
    "section",
    { class: "attention", "aria-label": "Needs attention" },
    sections.map(([heading, note, rows, limit = Infinity]) => {
      const items = rows.map((row, index) => {
        const item = fixRow(pin, row);
        item.hidden = index >= limit;
        return item;
      });
      // Folded rows are drawn but hidden, so the counts on the page add up
      // whether or not anyone asked to see them.
      const more =
        rows.length > limit &&
        el("button", {
          type: "button",
          class: "more-rows",
          text: `Show all ${rows.length}`,
          onclick: (event) => {
            for (const item of items) item.hidden = false;
            event.currentTarget.remove();
          },
        });
      return el("div", { class: "fix-group" }, [
        el("h3", {}, [
          heading,
          el("span", { class: "n", text: String(rows.length) }),
        ]),
        note && el("p", { class: "section-note", text: note }),
        el("ul", { class: "fixes" }, items),
        more,
      ]);
    }),
  );
}

function groupRow(group) {
  const label = FINDING_LABEL[group.id] ?? group.id;
  return {
    attribute: group.attribute,
    title: label,
    note: group.attribute ? label : el("code", { text: group.id }),
    message: group.message,
    count: group.count,
    where: group.where,
  };
}

function fixRow(pin, row) {
  return el("li", { "data-findings": String(row.count) }, [
    el("div", { class: "what" }, [
      row.attribute ? attributeLink(row.attribute, pin) : row.title,
      el("small", {}, row.note),
    ]),
    el("div", { class: "why" }, [
      row.message,
      row.count > 1 &&
        el("span", { class: "reported", text: ` · reported ${row.count}×` }),
      row.where.size > 0 && where(row.where),
    ]),
  ]);
}

/** Where a row applies; a chip that names a signal in the table opens it. */
function where(places) {
  const chips = [...places].map(([label, key]) =>
    key
      ? el("button", {
          type: "button",
          class: "where-chip",
          "data-opens": key,
          title: "Show this signal",
          text: label,
        })
      : el("code", { text: label }),
  );
  const list = el("span", { class: "where" }, chips);
  return places.size > WHERE_FOLD
    ? el("details", { class: "where-fold" }, [
        el("summary", { text: `on ${plural(places.size, "signal")}` }),
        list,
      ])
    : list;
}

function signalTable(view) {
  const { signals, pin } = view;
  if (!signals.length)
    return el("section", { "aria-label": "Signals" }, [
      el("h3", { text: "Signals" }),
      el("p", {
        class: "note",
        text: "This run emitted no signal that matches a declaration in the pinned registry, so there is no coverage to show. Everything weaver reported is listed above.",
      }),
    ]);
  // Worst first: a required miss outranks any number of findings, because it
  // is the one thing a reader can be sure is the instrumentation's to fix.
  const rows = signals
    .slice()
    .sort(
      (a, b) =>
        b.requiredMissing - a.requiredMissing ||
        b.groups.size - a.groups.size ||
        a.signal.name.localeCompare(b.signal.name),
    )
    .flatMap((s) => {
      const detail = el("tr", { class: "signal-detail", hidden: true }, [
        el("td", { colspan: 6 }, signalDetail(s, pin)),
      ]);
      const row = el("tr", { "data-signal": s.key }, [
        el("td", {}, [
          el("button", {
            type: "button",
            class: "row-toggle mono",
            "aria-expanded": "false",
            text: s.signal.name,
            onclick: () => expand(row, detail.hidden),
          }),
        ]),
        el("td", { class: "kind", text: s.kind }),
        el("td", {}, coverageBar(s.signal.coverage?.required, "required")),
        el(
          "td",
          {},
          coverageBar(s.signal.coverage?.recommended, "recommended"),
        ),
        el(
          "td",
          {},
          s.signal.coverage ? levelBar(s.signal.coverage) : coverageBar(null),
        ),
        el(
          "td",
          { class: "num" },
          s.groups.size > 0
            ? el("span", {
                class: `count-badge${s.requiredMissing ? " hot" : ""}`,
                text: String(s.groups.size),
              })
            : el("span", { class: "ver", text: "—" }),
        ),
      ]);
      return [row, detail];
    });
  return el("section", { "aria-label": "Signals" }, [
    el("h3", {}, [
      "Signals",
      el("span", {
        class: "n",
        text: "worst first · open a row for its attributes",
      }),
    ]),
    el("div", { class: "table-wrap" }, [
      el("table", { class: "signal-table" }, [
        el("thead", {}, [
          el(
            "tr",
            {},
            [
              "Signal",
              "Kind",
              "Required",
              "Recommended",
              "All levels",
              "Findings",
            ].map((label, index) =>
              el("th", { class: index === 5 ? "num" : null, text: label }),
            ),
          ),
        ]),
        el("tbody", {}, rows),
      ]),
    ]),
    levelLegend(),
  ]);
}

function expand(row, open) {
  row.nextElementSibling.hidden = !open;
  row.querySelector(".row-toggle").setAttribute("aria-expanded", String(open));
}

function signalDetail(s, pin) {
  const column = (heading, kind, names, levels = {}) =>
    el("div", { class: "attr-column", "data-column": kind }, [
      el("h4", { text: `${heading} (${names.length})` }),
      names.length
        ? el(
            "ul",
            { class: `attr-list ${kind}` },
            names.map((name) =>
              el("li", {}, [
                levels[name] && levelDot(levels[name]),
                attributeLink(name, pin),
              ]),
            ),
          )
        : el("p", { class: "ver", text: "None" }),
    ]);
  const groups = [...s.groups];
  return [
    s.signal.coverage
      ? el("div", { class: "attr-split" }, [
          column("Emitted", "emitted", s.emitted, s.levels),
          column("Not emitted", "missing", s.missing, s.levels),
          s.extra.length > 0 && column(KINDS.unregistered, "extra", s.extra),
        ])
      : [
          el("p", {
            class: "note",
            text: "This signal has no declaration in the pinned registry. There is no denominator; its emitted attributes are left uncounted.",
          }),
          el("div", { class: "attr-split" }, [
            column("Emitted", "extra", s.signal.emitted.slice().sort()),
          ]),
        ],
    groups.length > 0 &&
      el("div", { class: "signal-findings" }, [
        el("h4", { text: `Findings (${groups.length})` }),
        el(
          "ul",
          { class: "fixes" },
          groups.map((group) =>
            fixRow(pin, { ...groupRow(group), where: new Map() }),
          ),
        ),
      ]),
    el("a", {
      class: "compare",
      href: compareUrl(s.key),
      text: "compare across targets →",
    }),
  ];
}

function levelDot(level) {
  return el("i", {
    class: "dot",
    style: `background:${levelColor(level)}`,
    title: LEVEL_LABEL[level] ?? level,
  });
}

function attributeLink(name, pin) {
  const href = attributeUrl(name, pin);
  return href
    ? el("a", { href, rel: "noreferrer", text: name })
    : el("code", { text: name });
}

function chips(names) {
  return el(
    "span",
    { class: "attrs" },
    names.map((name) => el("code", { text: name })),
  );
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
  const names = Object.keys(found.entities ?? {}).sort();
  if (!names.length) return null;
  const declared = data.report.registry?.[found.runner]?.entities ?? {};

  return el("section", { "aria-label": "Resource entities" }, [
    el("h3", {}, [
      "Resource entities",
      el("span", {
        class: "n",
        text: "recognised only when every identifying attribute was present",
      }),
    ]),
    el("div", { class: "table-wrap" }, [
      el("table", { class: "entity-table" }, [
        el("thead", {}, [
          el(
            "tr",
            {},
            ["Entity", "Identified by", "Descriptive", "Not emitted"].map(
              (label) => el("th", { text: label }),
            ),
          ),
        ]),
        el(
          "tbody",
          {},
          names.map((name) => {
            const entity = found.entities[name];
            const description = Object.keys(declared[name]?.description ?? {});
            const carried = new Set(entity.description);
            const absent = description.filter((a) => !carried.has(a));
            return el("tr", {}, [
              el("td", { class: "mono", text: name }),
              el("td", {}, chips(entity.identity)),
              // No declared descriptive attributes — `service.instance` is
              // one — is not the same as having emitted none of them.
              el(
                "td",
                {},
                description.length
                  ? `${entity.description.length}/${description.length}`
                  : el("span", {
                      class: "ver",
                      text: "nothing further declared",
                    }),
              ),
              el(
                "td",
                {},
                absent.length
                  ? chips(absent)
                  : el("span", { class: "ver", text: "—" }),
              ),
            ]);
          }),
        ),
      ]),
    ]),
  ]);
}
