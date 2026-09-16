import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { actionRpc, diffRpc, snapshotRpc } from "../shared/contracts";
import { describeFile, parseGitDiff, shouldHighlight } from "./diff";
import {
 findRepoRoot,
 hasJj,
 listBookmarks,
 listChangedFiles,
 listChanges,
 listConflictedPaths,
 readCurrentDescription,
 runJj,
} from "./jj";

const RECENT_LIMIT = 30;
const MAX_DIFF_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 4000;

/**
 * Every argument reaches jj as a separate argv entry, so there is no shell to
 * inject into. A leading dash is the remaining hazard: the client supplies
 * revsets and paths, and `jj log -r --config=…` would be read as a flag rather
 * than a revision.
 */
function safeArg(value: string): string | null {
 const trimmed = value.trim();
 if (trimmed.startsWith("-")) return null;
 return trimmed;
}

export async function snapshot({
 directory,
}: RpcInput<typeof snapshotRpc>): Promise<RpcOutput<typeof snapshotRpc>> {
 const empty = {
  isRepo: false,
  root: null,
  error: null,
  jjAvailable: true,
  current: null,
  parent: null,
  conflicts: [],
  files: [],
  bookmarks: [],
  recent: [],
 };

 if (!(await hasJj())) return { ...empty, jjAvailable: false };

 const root = await findRepoRoot(directory);
 if (!root) return empty;

 const [current, parent, description, conflicts, files, bookmarks, recent] = await Promise.all([
  listChanges(root, "@", 1),
  listChanges(root, "@-", 1),
  readCurrentDescription(root),
  listConflictedPaths(root),
  listChangedFiles(root, "@"),
  listBookmarks(root),
  listChanges(root, "::@", RECENT_LIMIT),
 ]);

 const head = current[0] ?? null;
 // `jj root` succeeds in a repository jj cannot actually read — a working-copy
 // symlink Windows refuses, for example. Reporting an empty panel there hides
 // the cause, so jj's own message is surfaced instead.
 if (!head) {
  const probe = await runJj(["status"], root);
  if (!probe.ok) {
   return {
    isRepo: true,
    root,
    error: probe.stderr || "jj could not read this workspace.",
    jjAvailable: true,
    current: null,
    parent: null,
    conflicts: [],
    files: [],
    bookmarks: [],
    recent: [],
   };
  }
 }

 // `jj log` collapses a description to one line; the working copy wants the
 // whole thing, including newlines.
 const fullHead = head && description !== null ? { ...head, description: description.trimEnd() } : head;

 return {
  isRepo: true,
  root,
  error: null,
  jjAvailable: true,
  current: fullHead,
  parent: parent[0] ?? null,
  conflicts,
  files,
  bookmarks,
  recent,
 };
}

export async function diff({
 directory,
 revset,
 path,
}: RpcInput<typeof diffRpc>): Promise<RpcOutput<typeof diffRpc>> {
 const failed = {
  files: [],
  additions: 0,
  deletions: 0,
  truncated: false,
  error: null as string | null,
 };

 const root = await findRepoRoot(directory);
 if (!root) return { ...failed, error: "Not a jj workspace." };

 const revision = safeArg(revset) ?? "@";
 const args = ["diff", "--git", "-r", revision];
 if (path) {
  const target = safeArg(path);
  if (!target) return { ...failed, error: "Invalid path." };
  args.push("--", target);
 }

 const result = await runJj(args, root);
 if (!result.ok) return { ...failed, error: result.stderr || "jj diff failed." };
 if (result.stdout.length > MAX_DIFF_BYTES) {
  return { ...failed, truncated: true, error: "Diff is too large to display." };
 }

 const { files: raw, truncated } = parseGitDiff(result.stdout);
 const totalLines = raw.reduce(
  (sum, file) => sum + file.hunks.reduce((count, hunk) => count + hunk.lines.length, 0),
  0,
 );
 const highlight = shouldHighlight(totalLines);

 const files = raw.map((file) => describeFile(file, highlight));
 return {
  files,
  additions: files.reduce((sum, file) => sum + file.additions, 0),
  deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  truncated,
  error: null,
 };
}

export async function action({
 directory,
 action: kind,
 message,
 revset,
 paths,
}: RpcInput<typeof actionRpc>): Promise<RpcOutput<typeof actionRpc>> {
 const root = await findRepoRoot(directory);
 if (!root) return { ok: false, error: "Not a jj workspace.", output: "" };

 const text = (message ?? "").slice(0, MAX_MESSAGE_LENGTH).trim();
 const revision = revset ? safeArg(revset) : null;
 if (revset && !revision) return { ok: false, error: "Invalid revision.", output: "" };

 let args: string[];
 switch (kind) {
  case "commit":
   if (!text) return { ok: false, error: "A commit message is required.", output: "" };
   // `jj commit` is describe plus `jj new`, which is exactly "save this
   // change and start the next one".
   args = ["commit", "-m", text];
   break;
  case "describe":
   if (!text) return { ok: false, error: "A description is required.", output: "" };
   args = ["describe", "-m", text, "-r", revision ?? "@"];
   break;
  case "new":
   args = text ? ["new", "-m", text] : ["new"];
   break;
  case "undo":
   args = ["undo"];
   break;
  case "abandon":
   args = ["abandon", revision ?? "@"];
   break;
  case "restore": {
   const targets = (paths ?? [])
    .map(safeArg)
    .filter((value): value is string => value !== null);
   if (targets.length === 0) return { ok: false, error: "Select at least one file.", output: "" };
   args = ["restore", ...(revision ? ["--from", revision] : []), "--", ...targets];
   break;
  }
  default:
   return { ok: false, error: "Unsupported action.", output: "" };
 }

 const result = await runJj(args, root);
 return {
  ok: result.ok,
  error: result.ok ? null : result.stderr || "jj command failed.",
  output: (result.stdout || result.stderr).trim(),
 };
}
