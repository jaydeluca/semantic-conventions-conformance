// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// The report, and the indices every view reads it through.
//
// A few dozen targets and a few thousand attribute records, so everything
// here is built once in memory rather than precomputed into the file. That is
// what keeps the report one shape: it says what was observed, and the
// questions — which attribute nobody emits, which targets share a signal —
// are answered here instead of being baked in as extra denormalised copies
// that could disagree with it.

/** Requirement levels, ordered by how much an absence from one means. */
export const LEVELS = [
  'required',
  'conditionally_required_conditional',
  'recommended',
  'recommended_conditional',
  'opt_in',
];

export const LEVEL_LABEL = {
  required: 'Required',
  conditionally_required_conditional: 'Conditionally required',
  recommended: 'Recommended',
  recommended_conditional: 'Recommended (conditional)',
  opt_in: 'Opt-in',
};

const LEVEL_VAR = {
  required: '--required',
  conditionally_required_conditional: '--conditional',
  recommended: '--recommended',
  recommended_conditional: '--conditional',
  opt_in: '--optin',
};

export const levelColor = (level) => `var(${LEVEL_VAR[level] ?? '--optin'})`;

/**
 * A stable colour per language.
 *
 * Assigned once from the sorted set the report contains, rather than from a
 * hardcoded map, so a new language in `scenarios/` gets a colour without a
 * code change — and assigned by name rather than by first appearance, so the
 * colour a reader learns on one view is the colour it has on every other.
 *
 * Filled in by `index()`, so `languageColor` only answers after `load()`.
 */
const LANGUAGE_SLOT = new Map();

/** How many `--lang-N` tokens `style.css` defines. */
const LANGUAGE_SLOTS = 6;

export const languageColor = (language) =>
  `var(--lang-${LANGUAGE_SLOT.get(language) ?? LANGUAGE_SLOTS})`;

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

/**
 * The report shape this file knows how to read.
 *
 * The vocabulary above — the level names, and which of them are scored — is
 * the report's, restated here because the site has no way to import Python.
 * A level rename upstream would leave every bar reading zero with nothing to
 * say why, so the version the report stamps itself with is checked instead:
 * an unreadable report should say so rather than render a wrong one.
 */
const SCHEMA_VERSION = 1;

export async function load() {
  const report = await fetchJson('data/conformance.json');
  if (report.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `data/conformance.json is schema_version ${report.schema_version}; ` +
        `this page reads ${SCHEMA_VERSION}`,
    );
  }
  return index(report);
}

/** How a signal is addressed — in the index below, and in a `#/signals/` link. */
const signalKey = (type, name) => `${type}:${name}`;

function index(report) {
  const languages = [...new Set(report.targets.map((t) => t.language))].sort();
  LANGUAGE_SLOT.clear();
  languages.forEach((language, i) =>
    LANGUAGE_SLOT.set(language, (i % LANGUAGE_SLOTS) + 1),
  );

  const targets = report.targets;

  // Signals, each with the registry's declaration and everyone who emits it.
  //
  // Keyed the way the report keys one — by type and name together, not by name
  // alone. A metric and a span may share a name, and the entry carries the
  // declaration everything below it is drawn against, so merging two would
  // render one signal's columns against the other's attribute list with
  // nothing on the page to say so.
  const signals = new Map();
  for (const target of targets) {
    for (const signal of target.signals) {
      const declared =
        report.registry?.[target.runner]?.[`${signal.type}s`]?.[signal.name] ??
        null;
      const key = signalKey(signal.type, signal.name);
      let entry = signals.get(key);
      if (!entry) {
        entry = {
          key,
          name: signal.name,
          type: signal.type,
          kind: null,
          runner: target.runner,
          attributes: null,
          rows: [],
        };
        signals.set(key, entry);
      }
      // First declaration wins, but an absent one never does: a target whose
      // runner does not declare the signal must not be what decides the whole
      // column set has nothing to compare against.
      if (entry.attributes === null && declared?.attributes) {
        entry.attributes = declared.attributes;
        entry.kind = declared.kind ?? null;
        entry.runner = target.runner;
      }
      entry.rows.push({ target, signal });
    }
  }

  return { report, targets, signals };
}

/**
 * The least that still tells a set of targets apart.
 *
 * Printing the full coordinate on every column spends the width on what they
 * share — most of the java targets are the same javaagent — and clips the part
 * that differs. So: name the library, and add the report's `label` only when
 * two targets in the set share a library under different instrumentations,
 * the side only when the set mixes both. Computed per set, because what
 * distinguishes a target is a fact about its company, not about the target.
 */
export function distinguish(targets) {
  const byLibrary = new Map();
  for (const target of targets) {
    const key = target.instrumented_library;
    if (!byLibrary.has(key)) byLibrary.set(key, new Set());
    byLibrary.get(key).add(target.label);
  }
  const sides = new Set(targets.map((target) => target.side ?? ''));

  return new Map(
    targets.map((target) => {
      const parts = [];
      if (byLibrary.get(target.instrumented_library).size > 1) {
        parts.push(target.label);
      }
      if (sides.size > 1 && target.side) parts.push(target.side);
      return [
        target.id,
        {
          primary: target.instrumented_library,
          secondary: parts.join(' · ') || null,
          full: fullLabel(target),
        },
      ];
    }),
  );
}

/** Everything about a target's identity, for a tooltip or a label. */
export function fullLabel(target) {
  const side = target.side ? ` ${target.side}` : '';
  return `${target.instrumented_library} · ${target.label}${side}`;
}
