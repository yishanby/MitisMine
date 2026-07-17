import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

export interface TrackedSecretMatch {
  readonly key: string;
  readonly file: string;
}

export function findTrackedSecretMatches(
  dotenv: string,
  trackedFiles: ReadonlyMap<string, string>,
): TrackedSecretMatch[] {
  const environment = parseEnv(dotenv);
  const secrets = Object.entries(environment).filter(
    (entry): entry is [string, string] =>
      isSecretKey(entry[0]) && typeof entry[1] === "string" && entry[1].length >= 8,
  );
  const matches: TrackedSecretMatch[] = [];
  for (const [key, value] of secrets) {
    for (const [file, content] of trackedFiles) {
      if (content.includes(value)) matches.push({ key, file });
    }
  }
  return matches;
}

function main(): void {
  const envPath = resolve(".env.local");
  if (!existsSync(envPath)) throw new Error(".env.local does not exist");
  const names = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const trackedFiles = new Map<string, string>();
  for (const name of names) {
    let indexContent: string | undefined;
    let worktreeContent: string | undefined;
    try {
      indexContent = execFileSync("git", ["show", `:${name}`], {
        encoding: "utf8",
        maxBuffer: 50 * 1_024 * 1_024,
      });
    } catch {
      // An unmerged or otherwise unreadable index entry is checked from the worktree below.
    }
    try {
      worktreeContent = readFileSync(resolve(name), "utf8");
    } catch {
      // A deleted worktree file is still checked from the staged index above.
    }
    if (indexContent !== undefined && indexContent === worktreeContent) {
      trackedFiles.set(name, indexContent);
    } else {
      if (indexContent !== undefined) trackedFiles.set(`${name} (index)`, indexContent);
      if (worktreeContent !== undefined) trackedFiles.set(`${name} (worktree)`, worktreeContent);
    }
  }
  const matches = findTrackedSecretMatches(readFileSync(envPath, "utf8"), trackedFiles);
  if (matches.length > 0) {
    for (const match of matches) process.stderr.write(`${match.key}: ${match.file}\n`);
    process.exitCode = 1;
    return;
  }
  const checked = Object.entries(parseEnv(readFileSync(envPath, "utf8")))
    .filter(([key, value]) => isSecretKey(key) && typeof value === "string" && value.length >= 8)
    .length;
  process.stdout.write(`Tracked secret scan passed (${checked} keys, ${names.length} files).\n`);
}

function isSecretKey(key: string): boolean {
  return /(?:SECRET|TOKEN|PASSWORD|PASSWD|COOKIE|CREDENTIAL|KEY|AUTHORIZATION)/i.test(key);
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tracked secret scan failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
