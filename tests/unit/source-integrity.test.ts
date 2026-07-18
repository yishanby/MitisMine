import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const excludedDirectories = new Set(["data", "dist", "node_modules", ".git"]);

function filesUnder(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) return [];
    const child = resolve(path, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child];
  });
}

describe("source integrity", () => {
  it("contains no Unicode replacement characters in product, documentation, or tests", () => {
    const repositoryRoot = resolve(import.meta.dirname, "../..");
    const targets = ["apps", "packages", "README.md", "docs", "tests"]
      .flatMap((target) => filesUnder(resolve(repositoryRoot, target)));
    const replacementCharacter = String.fromCodePoint(0xfffd);
    const corruptFiles = targets
      .filter((path) => readFileSync(path, "utf8").includes(replacementCharacter))
      .map((path) => path.slice(repositoryRoot.length + 1).replaceAll("\\", "/"));

    expect(corruptFiles).toEqual([]);
  });
});
