import { execFile } from "node:child_process";
import { chdir, cwd as processCwd } from "node:process";
import type { JjChange, JjFileSummary } from "../shared/contracts";

export interface RunResult {
 ok: boolean;
 stdout: string;
 stderr: string;
}

/** Field and record separators for the log template. jj emits printable text,
 *  so control characters never collide with a description. */
const FIELD_SEP = "\u001f";
const RECORD_SEP = "\u001e";

let jjAvailable: boolean | null = null;

/**
 * `jj` is looked up once per subprocess. A missing binary is a normal state on
 * a machine without Jujutsu, not an error worth repeating on every poll.
 */
export async function hasJj(): Promise<boolean> {
 if (jjAvailable !== null) return jjAvailable;
 const result = await runJj(["--version"], processCwd());
 jjAvailable = result.ok;
 return jjAvailable;
}

export function runJj(args: string[], cwd: string): Promise<RunResult> {
 const { promise, resolve } = Promise.withResolvers<RunResult>();
 execFile(
  "jj",
  args,
  { cwd, encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  (error, stdout, stderr) => {
   if (error) {
    const message = (stderr || stdout || error.message).trim();
    resolve({ ok: false, stdout: stdout ?? "", stderr: message });
    return;
   }
   resolve({ ok: true, stdout: stdout ?? "", stderr: stderr ?? "" });
  },
 );
 return promise;
}

export async function findRepoRoot(directory: string): Promise<string | null> {
 const result = await runJj(["root"], directory);
 if (!result.ok) return null;
 return result.stdout.trim() || null;
}

/**
 * One record per revision, fields in a fixed order. Every separator must be a
 * *quoted* jj string literal — a bare control character is a template syntax
 * error. Descriptions are first-line-only here; the full text is fetched
 * separately for the working copy, where newlines matter and there is only one
 * record to disambiguate.
 */
const LOG_FIELDS = [
 "change_id",
 "commit_id",
 "author.name()",
 'author.timestamp().format("%Y-%m-%d %H:%M")',
 'if(empty, "1", "0")',
 'if(conflict, "1", "0")',
 'bookmarks.join(",")',
 "description.first_line()",
 // Parents come last so a record that predates them still parses its head. The
 // full change id is required: a shortened one does not match `change_id`, and
 // a graph whose edges match no node is a column of unconnected dots.
 'parents.map(|c| c.change_id()).join(",")',
 'if(immutable, "1", "0")',
 "committer.name()",
 'committer.timestamp().format("%Y-%m-%d %H:%M")',
 "author.timestamp().ago()",
 'tags.join(",")',
 'if(divergent, "1", "0")',
];

const LOG_TEMPLATE =
 `"${RECORD_SEP}" ++ ` + LOG_FIELDS.join(` ++ "${FIELD_SEP}" ++ `) + ` ++ "\\n"`;

function parseChanges(stdout: string): JjChange[] {
 const changes: JjChange[] = [];
 for (const record of stdout.split(RECORD_SEP)) {
  const trimmed = record.replace(/^\s+/, "");
  if (!trimmed) continue;
  const fields = trimmed.split(FIELD_SEP);
  if (fields.length < 8) continue;
  changes.push({
   changeId: fields[0] ?? "",
   commitId: (fields[1] ?? "").slice(0, 12),
   author: fields[2] ?? "",
   timestamp: fields[3] ?? "",
   empty: fields[4] === "1",
   conflicted: fields[5] === "1",
   bookmarks: (fields[6] ?? "").split(",").filter(Boolean),
   description: (fields[7] ?? "").replace(/\n$/, ""),
   parents: (fields[8] ?? "").split(",").filter(Boolean),
   immutable: fields[9] === "1",
   committer: fields[10] ?? "",
   committerTimestamp: fields[11] ?? "",
   age: fields[12] ?? "",
   tags: (fields[13] ?? "").split(",").filter(Boolean),
   divergent: fields[14] === "1",
  });
 }
 return changes;
}

export async function listChanges(
 root: string,
 revset: string,
 limit: number,
): Promise<JjChange[]> {
 const result = await runJj(
  ["log", "--no-graph", "-r", revset, "-n", String(limit), "--template", LOG_TEMPLATE],
  root,
 );
 if (!result.ok) return [];
 return parseChanges(result.stdout);
}

/** The full description of `@`, including newlines, since one record cannot be
 *  ambiguous. */
export async function readCurrentDescription(root: string): Promise<string | null> {
 const result = await runJj(
  ["log", "--no-graph", "-r", "@", "--template", "description"],
  root,
 );
 if (!result.ok) return null;
 return result.stdout;
}

/** jj prints paths with the platform separator on Windows, while the git diff
 *  format always uses forward slashes. Normalising at the boundary keeps the
 *  file summary matching the diff paths it navigates. */
export function normalizePath(path: string): string {
 return path.replace(/\\/g, "/");
}

const STATUS_BY_LETTER: Record<string, JjFileSummary["status"]> = {
 A: "added",
 M: "modified",
 D: "removed",
 R: "renamed",
 C: "copied",
};

/** `jj diff --summary` prints one status letter and path per file. */
export async function listChangedFiles(
 root: string,
 revset: string,
): Promise<JjFileSummary[]> {
 const result = await runJj(["diff", "--summary", "-r", revset], root);
 if (!result.ok) return [];
 const files: JjFileSummary[] = [];
 for (const line of result.stdout.split("\n")) {
  const match = /^([AMDRC])\s+(.+)$/.exec(line.trim());
  if (!match) continue;
  files.push({ status: STATUS_BY_LETTER[match[1]] ?? "modified", path: normalizePath(match[2]) });
 }
 return files;
}

export async function listBookmarks(root: string): Promise<string[]> {
 const result = await runJj(["bookmark", "list", "--template", "name ++ \"\\n\""], root);
 if (!result.ok) return [];
 return result.stdout
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);
}

export async function listConflictedPaths(root: string): Promise<string[]> {
 const result = await runJj(["resolve", "--list"], root);
 if (!result.ok) return [];
 return result.stdout
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => normalizePath(line.split(/\s{2,}/)[0] ?? line));
}
