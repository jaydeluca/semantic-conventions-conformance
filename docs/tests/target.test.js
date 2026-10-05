// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { findingKind, load } from "../assets/data.js";
import { split } from "../assets/route.js";
import view, { title } from "../assets/views/target.js";
import signals from "../assets/views/signals.js";
import { report, target } from "./fixtures.js";
import { setup } from "./harness.js";

const coverage = {
  required: { emitted: 1, declared: 1 },
  recommended: { emitted: 0, declared: 1 },
};
function detailed() {
  const document = report([
    target({
      scenario_classes: ["query"],
      signals: [
        {
          type: "metric",
          name: "db.duration",
          emitted: ["db.system", "extra"],
          missing: ["db.namespace"],
          coverage,
        },
        { type: "span", name: "query", emitted: ["db.system"], coverage },
        { type: "event", name: "log", emitted: [], coverage },
        { type: "metric", name: "unknown", emitted: ["custom"] },
      ],
      findings: [
        {
          id: "missing_attribute",
          message: "Extra attribute",
          signal_type: "metric",
          signal_name: "db.duration",
        },
        {
          id: "required_attribute_not_present",
          message: "Expected attribute",
          signal_type: "log",
          signal_name: "log",
        },
        ...Array.from({ length: 4 }, () => ({
          id: "type_mismatch",
          message: "Wrong type",
          signal_type: "metric",
          signal_name: "db.duration",
        })),
        {
          id: "new_rule",
          message: "Unknown violation",
          signal_type: "span",
          // The span's own name, which is not the registry's.
          signal_name: "SELECT",
        },
      ],
      entities: { service: { identity: ["service.name"], description: [] } },
    }),
    // A second instrumentation of jdbc, so the same-library link has a peer.
    target({
      id: "database/java/mariadb/jdbc/other",
      instrumentation_library: "other",
      label: "other",
      path: "scenarios/database/java/mariadb/jdbc/other",
      signals: [{ type: "metric", name: "db.duration", emitted: [] }],
    }),
  ]);
  document.registry["database-conformance"].spans = {
    query: { kind: "client", attributes: { "db.system": "required" } },
  };
  document.registry["database-conformance"].events = {
    log: { attributes: { "db.namespace": "recommended" } },
  };
  document.registry["database-conformance"].entities = {
    service: { description: { "service.version": "recommended" } },
  };
  return document;
}

test("facts, typed panels, coverage attributes, entities and comparison links", async (t) => {
  const document = detailed();
  await setup(t, document);
  const data = await load();
  const page = view(data, document.targets[0].id);
  assert.ok(
    page.querySelector(
      'a[href="https://github.com/open-telemetry/demo/tree/v1/model"]',
    ),
  );
  assert.ok(
    page.querySelector(
      `a[href="https://github.com/open-telemetry/semantic-conventions-conformance/tree/main/${document.targets[0].path}"]`,
    ),
  );
  assert.match(page.textContent, /query/);
  assert.deepEqual(
    [...page.querySelectorAll(":scope > section[aria-label]")].map((node) =>
      node.getAttribute("aria-label"),
    ),
    ["Coverage", "Spans", "Metrics", "Events", "Findings"],
  );
  const metric = page.querySelector('section[aria-label="Metrics"]');
  assert.equal(
    metric.querySelector('[data-level="required"] .emitted').textContent,
    "db.system",
  );
  assert.equal(
    metric.querySelector('[data-level="recommended"] .missing').textContent,
    "db.namespace",
  );
  assert.equal(
    metric.querySelector(".unregistered-attributes code").textContent,
    "extra",
  );
  assert.match(metric.textContent, /no declaration/);
  assert.match(page.querySelector(".entity").textContent, /service.version/);
  const link = split(metric.querySelector(".compare").getAttribute("href"));
  assert.equal(link.path, "/signals/metric:db.duration");
  assert.ok(
    signals(data, link.path.slice("/signals/".length)).querySelector("table"),
  );
  const same = [...page.querySelectorAll(".facts a")].find((a) =>
    a.textContent.startsWith("Compare all"),
  );
  const route = split(same.getAttribute("href"));
  assert.equal(route.params.get("lib"), "jdbc");
  assert.equal(
    signals(
      data,
      route.path.slice("/signals/".length),
      route.params,
    ).querySelector('select[aria-label="Library"]').value,
    "jdbc",
  );
  assert.match(title(data, document.targets[0].id), /jdbc.*conformance/);
});

test("findings are classified, counted, folded, and reached from signal cards", async (t) => {
  const document = detailed();
  const window = await setup(t, document, `#/target/${document.targets[0].id}`);
  const page = view(await load(), document.targets[0].id);
  window.document.querySelector("main").replaceChildren(page);
  assert.deepEqual(
    [...page.querySelectorAll(".findings [data-kind]")].map(
      (node) => node.dataset.kind,
    ),
    ["violation", "absent", "unregistered"],
  );
  assert.equal(
    page.querySelector(".finding-counts").textContent,
    "5 breaking the convention · 1 expected, not emitted · 1 not in the registry",
  );
  assert.equal(page.querySelectorAll(".finding").length, 7);
  assert.equal(page.querySelector("#finding-missing_attribute").open, false);
  assert.equal(page.querySelector("#finding-type_mismatch").open, false);
  assert.equal(
    page.querySelector("#finding-required_attribute_not_present").open,
    true,
  );
  assert.equal(page.querySelectorAll(".finding-id a").length, 0);
  assert.match(
    page.querySelector('section[aria-label="Events"] .signal-findings')
      .textContent,
    /1 finding:/,
  );
  assert.match(
    page.querySelector('section[aria-label="Spans"] .signal-findings')
      .textContent,
    /1 finding:/,
  );
  page.querySelector('[data-finding="finding-type_mismatch"]').click();
  assert.equal(page.querySelector("#finding-type_mismatch").open, true);
  assert.equal(window.location.hash, `#/target/${document.targets[0].id}`);
  assert.equal(
    window.document.activeElement,
    page.querySelector("#finding-type_mismatch summary"),
  );
});

test("unknown and empty routes retain picker; multiword search and hotkey route escaped ids", async (t) => {
  const item = target({
    id: "http/java/a space/server?",
    domain: "http",
    language: "java",
    instrumented_library: "armeria",
    side: "server",
  });
  const window = await setup(t, report([item]));
  const data = await load();
  assert.match(
    view(data, "nope").querySelector(".note").textContent,
    /No instrumentation called nope/,
  );
  const page = view(data, null);
  window.document.querySelector("main").replaceChildren(page);
  assert.equal(page.querySelector(".note"), null);
  assert.equal(title(data, null), "instrumentations · conformance");
  window.document.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "k", metaKey: true }),
  );
  assert.equal(page.querySelector(".palette").hidden, false);
  const input = page.querySelector("input");
  input.value = "java armeria server";
  input.dispatchEvent(new window.Event("input"));
  assert.equal(page.querySelectorAll('[role="option"]').length, 1);
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }));
  assert.equal(window.location.hash, "#/target/http/java/a%20space/server%3F");
  assert.equal(split(window.location.hash).path, "/target/" + item.id);
});

test("every committed target renders all findings, including the largest run", async (t) => {
  const document = JSON.parse(
    await readFile(
      new URL("../data/conformance.json", import.meta.url),
      "utf8",
    ),
  );
  await setup(t, document);
  const data = await load();
  for (const item of data.targets) {
    const page = view(data, item.id);
    assert.equal(
      page.querySelectorAll(".finding").length,
      item.findings.length,
      item.id,
    );
    assert.equal(
      page.querySelectorAll(".compare").length,
      item.signals.length,
      item.id,
    );
    // Span findings carry the span's own name, so a sole span is the only one
    // they can be placed on without guessing.
    const spans = page.querySelector('section[aria-label="Spans"]');
    const placed = [...(spans?.querySelectorAll(".signal-findings a") ?? [])]
      .map((a) => Number(a.textContent.match(/\((\d+)\)$/)[1]))
      .reduce((sum, n) => sum + n, 0);
    if (item.signals.filter((s) => s.type === "span").length === 1)
      assert.equal(
        placed,
        item.findings.filter(
          (f) =>
            f.signal_type === "span" && findingKind(f.id) !== "unregistered",
        ).length,
        item.id,
      );
  }
});
