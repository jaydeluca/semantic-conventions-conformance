// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// The report, and the indices every view reads it through.
//
// There are 47 targets and about a thousand attribute records, so everything
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

/** The two the site scores on. See `about` for why the others are counts. */
export const SCORED = ['required', 'recommended'];

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
 */
const LANGUAGE_SLOT = new Map();

export const languageColor = (language) =>
  `var(--lang-${LANGUAGE_SLOT.get(language) ?? 6})`;

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

export async function load() {
  return index(await fetchJson('data/conformance.json'));
}

function index(report) {
  const languages = [...new Set(report.targets.map((t) => t.language))].sort();
  LANGUAGE_SLOT.clear();
  languages.forEach((language, i) => LANGUAGE_SLOT.set(language, (i % 6) + 1));

  const targets = report.targets.map((target) => ({
    ...target,
    // What to call this implementation in a column or a link: the directory
    // it lives in, which is the repo's own answer to "which of the four
    // openai instrumentations is this". A coordinate is not — two of them
    // shorten to the same word.
    short: target.label,
    findingIds: countBy(target.findings.map((f) => f.id)),
  }));

  const byId = new Map(targets.map((t) => [t.id, t]));

  // Signals, each with the registry's declaration and everyone who emits it.
  const signals = new Map();
  for (const target of targets) {
    for (const signal of target.signals) {
      const declared =
        report.registry?.[target.runner]?.[`${signal.type}s`]?.[signal.name] ??
        null;
      let entry = signals.get(signal.name);
      if (!entry) {
        entry = {
          name: signal.name,
          type: signal.type,
          kind: declared?.kind ?? null,
          runner: target.runner,
          attributes: declared?.attributes ?? null,
          rows: [],
        };
        signals.set(signal.name, entry);
      }
      entry.rows.push({ target, signal });
    }
  }

  // Attributes, inverted: for each one the registry declares on a signal,
  // who emitted it. This is the view the report cannot answer by itself.
  const attributes = [];
  for (const signal of signals.values()) {
    if (!signal.attributes) continue;
    for (const [name, level] of Object.entries(signal.attributes)) {
      const emitted = signal.rows.filter((row) =>
        row.signal.emitted.includes(name),
      );
      attributes.push({
        name,
        level,
        signal: signal.name,
        signalType: signal.type,
        emitted: emitted.map((row) => row.target),
        eligible: signal.rows.map((row) => row.target),
      });
    }
  }

  const findings = new Map();
  for (const target of targets) {
    for (const finding of target.findings) {
      let entry = findings.get(finding.id);
      if (!entry) {
        entry = { id: finding.id, items: [] };
        findings.set(finding.id, entry);
      }
      entry.items.push({ target, finding });
    }
  }

  return { report, targets, byId, signals, attributes, findings };
}

/**
 * Whether a finding is about something that never arrived.
 *
 * Most of them are. Weaver records an attribute the registry requires and the
 * run did not carry as a violation (see the runner's `_report`), so the bulk
 * of the findings restate a coverage gap rather than describing something the
 * run got wrong — and a reader comparing a findings count to a coverage bar
 * is otherwise looking at the same fact twice without being told.
 *
 * Keyed on the id, because there is no field for this: every finding here is
 * at weaver's `violation` level and only the id distinguishes them.
 */
export const isAbsence = (id) =>
  id.startsWith('missing_') || id.includes('_missing') || id.endsWith('_not_present');

export function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/**
 * The least that still tells a set of targets apart.
 *
 * Printing the full coordinate on every column spends the width on what they
 * share — 27 of the 47 targets are the same javaagent — and clips the part
 * that differs. So: name the library, and add the instrumentation only when
 * two targets in the set share a library under different instrumentations,
 * the side only when the set mixes both. Computed per set, because what
 * distinguishes a target is a fact about its company, not about the target.
 */
export function distinguish(targets) {
  const shorts = new Map();
  for (const target of targets) {
    const key = target.instrumented_library;
    if (!shorts.has(key)) shorts.set(key, new Set());
    shorts.get(key).add(target.short);
  }
  const sides = new Set(targets.map((target) => target.side ?? ''));

  return new Map(
    targets.map((target) => {
      const parts = [];
      if (shorts.get(target.instrumented_library).size > 1) {
        parts.push(target.short);
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
  return `${target.instrumented_library} · ${target.short}${side}`;
}

/** A target's scored coverage for one level, as `{emitted, declared}`. */
export function scoreOf(target, level) {
  return target.summary?.[level] ?? { emitted: 0, declared: 0 };
}

/** A ratio in [0,1], or null when there was nothing to cover. */
export function ratio(tally) {
  return tally && tally.declared ? tally.emitted / tally.declared : null;
}
