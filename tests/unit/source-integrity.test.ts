import {
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const excludedDirectories = new Set(["data", "dist", "node_modules", ".git"]);
const textSourceExtensions = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".jsx", ".md", ".mdx", ".mjs",
  ".scss", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);
const replacementCharacterBytes = Buffer.from([0xef, 0xbf, 0xbd]);

function filesUnder(path: string): string[] {
  const status = lstatSync(path);
  if (status.isSymbolicLink()) return [];
  if (status.isFile()) return textSourceExtensions.has(extname(path).toLowerCase()) ? [path] : [];
  if (!status.isDirectory()) return [];
  return readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    .flatMap((entry) => {
      if (entry.isSymbolicLink()) return [];
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) return [];
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) return filesUnder(child);
      return entry.isFile() && textSourceExtensions.has(extname(child).toLowerCase()) ? [child] : [];
    });
}

function corruptSourceFiles(paths: readonly string[]): string[] {
  return paths
    .flatMap((path) => filesUnder(path))
    .filter((path) => readFileSync(path).includes(replacementCharacterBytes));
}

describe("source integrity", () => {
  it("walks deterministically without following valid or broken links", () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-source-walk-"));
    const root = join(directory, "root");
    const outside = join(directory, "outside");
    const removedTarget = join(directory, "removed-target");
    mkdirSync(root);
    mkdirSync(outside);
    mkdirSync(removedTarget);
    try {
      writeFileSync(join(root, "z-last.ts"), "export {};\n");
      writeFileSync(join(root, "a-first.md"), "# First\n");
      writeFileSync(join(outside, "external.ts"), "export {};\n");
      const linkType = process.platform === "win32" ? "junction" : "dir";
      symlinkSync(outside, join(root, "external-link"), linkType);
      symlinkSync(removedTarget, join(root, "broken-link"), linkType);
      rmSync(removedTarget, { recursive: true });

      expect(filesUnder(root).map((path) => basename(path)))
        .toEqual(["a-first.md", "z-last.ts"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("checks raw replacement bytes only in known text-source extensions", () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-source-bytes-"));
    try {
      const replacementBytes = Buffer.from([0xef, 0xbf, 0xbd]);
      writeFileSync(join(directory, "literal.ts"), Buffer.concat([
        Buffer.from("const value = \""), replacementBytes, Buffer.from("\";\n"),
      ]));
      writeFileSync(join(directory, "invalid.ts"), Buffer.from([0xff]));
      writeFileSync(join(directory, "binary.bin"), replacementBytes);

      expect(corruptSourceFiles([directory]).map((path) => basename(path)))
        .toEqual(["literal.ts"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("contains no Unicode replacement characters in product, documentation, or tests", () => {
    const repositoryRoot = resolve(import.meta.dirname, "../..");
    const targets = ["apps", "packages", "README.md", "docs", "tests"]
      .map((target) => resolve(repositoryRoot, target));
    const corruptFiles = corruptSourceFiles(targets)
      .map((path) => path.slice(repositoryRoot.length + 1).replaceAll("\\", "/"));

    expect(corruptFiles).toEqual([]);
  });
});
