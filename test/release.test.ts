// The release names one version in three places: package.json, the tenkai
// manifest and the image the manifest installs. The release workflow refuses a
// tag that disagrees; this catches the drift before a tag is pushed.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("package.json, the manifest and its image name the same version", () => {
  const { version } = JSON.parse(read("package.json")) as { version: string };
  const manifest = read("deploy/tenkai.toml");
  assert.match(manifest, new RegExp(`^version = "${version.replaceAll(".", "\\.")}"$`, "m"));
  assert.deepEqual([...manifest.matchAll(/ghcr\.io\/sannrox\/keiko:(\S+)/g)].map((m) => m[1]), [`v${version}`]);
});
