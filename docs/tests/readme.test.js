// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

// What the Pages workflow publishes, and so what README.md describes. The
// development files beside them — tests, the package manifests, README.md
// itself — are deliberately not in its table.
const PUBLISHED = ["index.html", "assets/", "data/"];

const root = new URL("../", import.meta.url);

/** Every published file, as a path relative to `docs/`. */
async function files() {
  const found = [];
  const walk = async (prefix) => {
    for (const entry of await readdir(new URL(prefix, root), {
      withFileTypes: true,
    })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(`${path}/`);
      else found.push(path);
    }
  };
  for (const entry of PUBLISHED) {
    if (entry.endsWith("/")) await walk(entry);
    else found.push(entry);
  }
  return found;
}

/** The paths named in the first column of README.md's table. */
async function documented() {
  const readme = await readFile(new URL("README.md", root), "utf8");
  return [...readme.matchAll(/^\| `([^`]+)` +\|/gm)].map((row) => row[1]);
}

// A trailing slash stands for the directory's contents, so a route added under
// `assets/views/` needs no new row but a new file beside it does.
const covers = (entry, file) =>
  entry.endsWith("/") ? file.startsWith(entry) : entry === file;

test("README.md describes every published file, and only files that exist", async () => {
  const entries = await documented();
  const present = await files();
  assert.ok(entries.length, "no table rows found in docs/README.md");

  for (const file of present) {
    assert.equal(
      entries.filter((entry) => covers(entry, file)).length,
      1,
      `${file} should appear in exactly one row of docs/README.md`,
    );
  }
  for (const entry of entries) {
    assert.ok(
      present.some((file) => covers(entry, file)),
      `docs/README.md describes ${entry}, which no longer exists`,
    );
  }
});
