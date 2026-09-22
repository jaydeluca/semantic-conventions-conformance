// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { report, target } from "./fixtures.js";

/** Same globals `app.js` expects, wired to a per-URL `fetch`. */
async function setup(t, fetchImpl, hash = "") {
  const html = await readFile(
    new URL("../index.html", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(html, { url: `https://example.test/${hash}` });
  const globals = {
    document: dom.window.document,
    Node: dom.window.Node,
    location: dom.window.location,
    history: dom.window.history,
    navigator: dom.window.navigator,
    addEventListener: dom.window.addEventListener.bind(dom.window),
    scrollTo: t.mock.fn(),
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
  t.mock.method(globalThis, "fetch", fetchImpl);
  t.after(() => dom.window.close());
  return dom.window;
}

test("picking a version loads its report and updates the URL", async (t) => {
  const a = report([target({ id: "a" })]);
  const b = report([target({ id: "b" }), target({ id: "c" })]);
  const versions = [
    { id: "a", label: "Version A", file: "data/conformance.json" },
    { id: "b", label: "Version B", file: "data/conformance-b.json" },
  ];

  const window = await setup(t, async (url) => {
    if (url === "data/versions.json")
      return { ok: true, json: async () => versions };
    if (url === "data/conformance-b.json")
      return { ok: true, json: async () => b };
    return { ok: true, json: async () => a };
  });
  // A distinct query string per test defeats the ESM module cache: each test
  // needs `app.js`'s top-level `boot()` to run fresh against its own mocks.
  await import("../assets/app.js?case=picker");
  await setImmediate();

  const select = window.document.querySelector("#version-bar select");
  assert.ok(select, "the picker renders when more than one report is declared");
  assert.equal(select.value, "a");
  assert.match(
    window.document.querySelector("#provenance").textContent,
    /1 targets/,
  );

  select.value = "b";
  select.dispatchEvent(new window.Event("change"));
  await setImmediate();

  assert.match(
    window.document.querySelector("#provenance").textContent,
    /2 targets/,
  );
  assert.equal(new URL(window.location.href).searchParams.get("v"), "b");

  // Back to the first (default) version drops the marker from the URL.
  select.value = "a";
  select.dispatchEvent(new window.Event("change"));
  await setImmediate();
  assert.equal(new URL(window.location.href).searchParams.get("v"), null);
});

test("a checkout with no version manifest keeps the picker hidden", async (t) => {
  const window = await setup(t, async (url) => {
    if (url === "data/versions.json") return { ok: false, status: 404 };
    return { ok: true, json: async () => report() };
  });
  await import("../assets/app.js?case=no-manifest");
  await setImmediate();

  assert.equal(window.document.querySelector("#version-bar").hidden, true);
});
