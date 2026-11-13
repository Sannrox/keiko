// A release names one version in package.json, both tenkai products and every
// image they install. The release workflow refuses a tag that disagrees; this
// catches the drift before a tag is pushed.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const { version } = JSON.parse(read("package.json")) as { version: string };
const images = (text: string): string[] => [...text.matchAll(/ghcr\.io\/sannrox\/keiko:(\S+)/g)].map((m) => m[1] ?? "");

test("both tenkai products carry the package version", () => {
  for (const manifest of ["deploy/tenkai.toml", "deploy/kubernetes/tenkai.toml"]) {
    assert.match(read(manifest), new RegExp(`^version = "${version.replaceAll(".", "\\.")}"$`, "m"), manifest);
  }
});

test("every image the products install is the package version", () => {
  const kube = readdirSync(new URL("../deploy/kubernetes/manifests", import.meta.url)).map((file) => read(`deploy/kubernetes/manifests/${file}`));
  const tags = [read("deploy/tenkai.toml"), ...kube].flatMap(images);
  assert.ok(tags.length >= 3);
  assert.deepEqual([...new Set(tags)], [`v${version}`]);
});
