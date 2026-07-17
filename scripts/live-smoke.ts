import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

interface CheckpointRow {
  checkpoint_json: string;
}

interface Checkpoint {
  run: {
    id: string;
    topicId: string;
    question: string;
    state: string;
    round: number;
    unresolved: boolean;
  };
  reports: Record<string, unknown>;
  sessions: Record<string, string>;
  reviews: Array<{ approved?: boolean }>;
  report?: {
    claims: Array<{
      importance: string;
      status: string;
      evidenceIds: string[];
    }>;
    evidence: Array<{ url: string }>;
  };
}

interface TopicRow {
  id: string;
  title: string;
}

interface SessionRow {
  provider: string;
  external_session_id: string | null;
}

interface ApprovalRow {
  status: string;
}

export function resolveLiveSmokePaths(
  env: Record<string, string | undefined>,
  cwd = process.cwd(),
): { databasePath: string; approvedPath: string } {
  const dataDirectory = env.MITISMINE_DATA_DIR ?? "data";
  return {
    databasePath: resolve(cwd, env.MITISMINE_DB_PATH ?? "data/mitismine.db"),
    approvedPath: resolve(cwd, dataDirectory, "approved-actions", "smoke", "approved.txt"),
  };
}

export function countCrossReviews(reviews: readonly { approved?: boolean }[]): number {
  return reviews.filter((review) => review.approved === undefined).length;
}

export function runLiveSmokeAudit(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): Record<string, unknown> {
  const paths = resolveLiveSmokePaths(env, cwd);
  const database = new DatabaseSync(paths.databasePath, { readOnly: true });

  try {
    const topic = database
      .prepare("SELECT id, title FROM topics WHERE title = ? ORDER BY created_at DESC LIMIT 1")
      .get("Live smoke") as TopicRow | undefined;
    if (topic === undefined) fail("Live smoke Topic is missing");

    const checkpoints = database
      .prepare(`
        SELECT checkpoint_json FROM orchestration_checkpoints
        WHERE topic_id = ? ORDER BY updated_at DESC, rowid DESC
      `)
      .all(topic.id) as unknown as CheckpointRow[];
    const run = checkpoints
      .map((row) => JSON.parse(row.checkpoint_json) as Checkpoint)
      .find(
        (checkpoint) =>
          checkpoint.run.state === "completed"
          && checkpoint.run.question.includes("RFC 2606")
          && Object.keys(checkpoint.reports).length === 3,
      );
    if (run === undefined || run.report === undefined) {
      fail("Completed three-provider RFC Run is missing");
    }

    const important = run.report.claims.filter((claim) => claim.importance === "important");
    const covered = important.filter(
      (claim) => claim.evidenceIds.length > 0 || claim.status === "unsupported",
    );
    const crossReviews = countCrossReviews(run.reviews);
    if (crossReviews < 6 || crossReviews % 6 !== 0) {
      fail("Cross-review count is invalid");
    }
    if (important.length !== covered.length) {
      fail("Important Claim evidence coverage is incomplete");
    }
    if (!run.report.evidence.some((evidence) => /rfc2606/i.test(evidence.url))) {
      fail("RFC 2606 primary-source evidence is missing");
    }

    const directSessions = database
      .prepare(`
        SELECT provider, MAX(external_session_id) AS external_session_id
        FROM direct_sessions
        WHERE topic_id = ? AND external_session_id IS NOT NULL
        GROUP BY provider ORDER BY provider
      `)
      .all(topic.id) as unknown as SessionRow[];
    if (
      directSessions.length !== 3
      || directSessions.some((session) => session.external_session_id === null)
    ) {
      fail("Three persistent direct sessions are required");
    }

    const approval = database
      .prepare("SELECT status FROM approval_requests WHERE topic_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(topic.id) as ApprovalRow | undefined;
    if (approval?.status !== "completed") fail("Smoke approval did not complete");
    if (
      !existsSync(paths.approvedPath)
      || readFileSync(paths.approvedPath, "utf8") !== "approved-by-feishu"
    ) {
      fail("Approved smoke file is missing or incorrect");
    }

    return {
      ok: true,
      topicId: topic.id,
      runId: run.run.id,
      state: run.run.state,
      round: run.run.round,
      unresolved: run.run.unresolved,
      providers: Object.keys(run.reports).sort(),
      reviews: run.reviews.length,
      crossReviews,
      claims: run.report.claims.length,
      evidence: run.report.evidence.length,
      importantCoverage: `${covered.length}/${important.length}`,
      directProviders: directSessions.map((session) => session.provider),
      approval: approval.status,
    };
  } finally {
    database.close();
  }
}

function fail(message: string): never {
  throw new Error(`Live smoke failed: ${message}`);
}

function main(): void {
  const envFile = resolve(".env.local");
  if (existsSync(envFile)) loadEnvFile(envFile);
  console.log(JSON.stringify(runLiveSmokeAudit(), null, 2));
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) main();
