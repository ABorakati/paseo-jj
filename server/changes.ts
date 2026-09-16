import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { actionRpc, diffRpc, snapshotRpc } from "../shared/contracts";
import { applyHunks, describeFile, parseGitDiff, shouldHighlight } from "./diff";
import {
 findRepoRoot,
 hasJj,
 listBookmarks,
 listChangedFiles,
 listChanges,
 listConflictedPaths,
 normalizePath,
 readCurrentDescription,
 runJj,
} from "./jj";

const RECENT_LIMIT = 30;
/** The graph also carries bookmarks outside `@`'s ancestry, so it is wider. */
const GRAPH_LIMIT = 60;
const GRAPH_REVSET = "::@ | ancestors(bookmarks(), 5)";
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
  graph: [],
 };

 if (!(await hasJj())) return { ...empty, jjAvailable: false };

 const root = await findRepoRoot(directory);
 if (!root) return empty;

 const [current, parent, description, conflicts, files, bookmarks, recent, graph] = await Promise.all([
  listChanges(root, "@", 1),
  listChanges(root, "@-", 1),
  readCurrentDescription(root),
  listConflictedPaths(root),
  listChangedFiles(root, "@"),
  listBookmarks(root),
  listChanges(root, "::@", RECENT_LIMIT),
  listChanges(root, GRAPH_REVSET, GRAPH_LIMIT),
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
    graph: [],
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
  graph,
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

/** The merge tool jj is pointed at for one hunk move. It is defined inline with
 *  `--config`, so no repository config is written and nothing is left behind. */
const HUNK_TOOL = "jj-panel-squash";

/**
 * jj gives a diff editor two directories and adopts whatever the right one
 * holds as the destination's new content. That is the only non-interactive way
 * to move part of a file, so the wanted text is computed here and this script
 * puts it in place.
 */
const HUNK_SCRIPT = [
 'const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");',
 'const { dirname, join } = require("node:path");',
 "const [, , _left, right, wanted, rel] = process.argv;",
 "const target = join(right, rel);",
 "mkdirSync(dirname(target), { recursive: true });",
 "writeFileSync(target, readFileSync(wanted));",
].join("\n");

interface HunkSquash {
 args: string[];
 /** Removes the script and the wanted text jj read during the command. */
 cleanup(): void;
}

/**
 * Everything one hunk move needs: the file's diff between the two revisions,
 * the destination's copy of the file, and the same copy with the selected hunks
 * applied. jj's own diff editor is a process, and the panel has no editor, so
 * the wanted text is handed over by a script in a temp directory. Building it
 * from the destination's copy is what makes any ancestor work as the target,
 * not just the parent.
 */
async function prepareHunkSquash(
 root: string,
 from: string,
 into: string,
 path: string,
 indexes: number[],
): Promise<HunkSquash | { error: string }> {
 const shown = await runJj(["diff", "--git", "--from", into, "--to", from, "--", path], root);
 if (!shown.ok) return { error: shown.stderr || "jj diff failed." };
 const file = parseGitDiff(shown.stdout).files[0];
 if (!file) return { error: "That file has no changes between those revisions." };
 if (file.binary) return { error: "Binary files cannot be squashed by hunk." };
 // A rename moves the file's name as well as its content, and an added or
 // removed file has no other side to apply hunks to; both are whole-path moves.
 if (file.status !== "modified") {
  return { error: `A ${file.status} file can only be squashed whole.` };
 }
 if (indexes.some((index) => index >= file.hunks.length)) {
  return { error: "Those hunks are no longer in this diff. Refresh and try again." };
 }

 const existing = await runJj(["file", "show", "-r", into, "--", path], root);
 if (!existing.ok) return { error: existing.stderr || "Could not read that file from the destination." };
 const wanted = applyHunks(existing.stdout, file.hunks, indexes);
 if (wanted === null) {
  return { error: "That file changed since the diff was drawn. Refresh and try again." };
 }

 const dir = mkdtempSync(join(tmpdir(), "paseo-jj-squash-"));
 const wantedFile = join(dir, "wanted");
 writeFileSync(wantedFile, wanted);
 const script = join(dir, "apply.cjs");
 writeFileSync(script, HUNK_SCRIPT);

 // jj parses each `--config` value as TOML, and a Windows path is not valid
 // TOML; JSON's escapes are, so every path goes through JSON.stringify.
 const config = (key: string, value: unknown) =>
  `--config=merge-tools.${HUNK_TOOL}.${key}=${JSON.stringify(value)}`;
 const relative = normalizePath(path);
 const tool = [script, "$left", "$right", wantedFile, relative];
 return {
  args: [
   "squash",
   "--from",
   from,
   "--into",
   into,
   "--tool",
   HUNK_TOOL,
   // The tool is spawned directly: node is the interpreter this server already
   // runs under, so no shell is involved and nothing else has to be on PATH.
   config("program", process.execPath),
   config("merge-args", tool),
   config("edit-args", tool),
   "--",
   path,
  ],
  cleanup: () => rmSync(dir, { recursive: true, force: true }),
 };
}

export async function action({
 directory,
 action: kind,
 message,
 revset,
 paths,
 hunkIndexes,
 name,
 target,
}: RpcInput<typeof actionRpc>): Promise<RpcOutput<typeof actionRpc>> {
 const root = await findRepoRoot(directory);
 if (!root) return { ok: false, error: "Not a jj workspace.", output: "" };

 const text = (message ?? "").slice(0, MAX_MESSAGE_LENGTH).trim();
 const revision = revset ? safeArg(revset) : null;
 if (revset && !revision) return { ok: false, error: "Invalid revision.", output: "" };

 let args: string[];
 /** Set by a case that prepared files on disk for jj to read. */
 let cleanup: (() => void) | null = null;
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
  case "bookmark-set":
  case "bookmark-delete": {
   // Bookmarks are refs, not shas: the name is the argument, so it is checked
   // like a revision and never allowed to look like a flag.
   const bookmark = name ? safeArg(name) : null;
   if (!bookmark) return { ok: false, error: "A bookmark name is required.", output: "" };
   if (kind === "bookmark-delete") {
    args = ["bookmark", "delete", bookmark];
    break;
   }
   // `jj bookmark set` both creates and moves, which is one verb for the reader
   // instead of two. A backwards move is refused by default; here the reader
   // picked the name and the revision by hand and `jj undo` takes it back, so
   // the explicit move is honoured.
   args = ["bookmark", "set", bookmark, "-r", revision ?? "@", "--allow-backwards"];
   break;
  }
  case "merge": {
   const other = target ? safeArg(target) : null;
   if (!other) return { ok: false, error: "Pick a second revision to merge.", output: "" };
   // A merge in jj is a change with two parents, and it becomes the working
   // copy so conflicts land where they can be edited.
   args = ["new", revision ?? "@", other];
   break;
  }
  case "rebase": {
   const destination = target ? safeArg(target) : null;
   if (!destination) return { ok: false, error: "Pick a destination revision.", output: "" };
   // `-b` moves the branch relative to the destination: the commits that are
   // not already there. `-s` would drag along everything below as well.
   args = ["rebase", "-b", revision ?? "@", "-d", destination];
   break;
  }
  case "redo":
   args = ["redo"];
   break;
  case "edit":
   args = ["edit", revision ?? "@"];
   break;
  case "duplicate": {
   const onto = target ? safeArg(target) : null;
   args = onto ? ["duplicate", revision ?? "@", "--onto", onto] : ["duplicate", revision ?? "@"];
   break;
  }
  case "squash": {
   const into = target ? safeArg(target) : null;
   // With no paths the whole revision moves, which is the verb the panel has
   // always offered. With paths jj moves only those files; a selection that
   // names nothing is refused the way `restore` refuses it.
   if (paths !== undefined) {
    const selected = paths.map(safeArg).filter((value): value is string => value !== null);
    if (selected.length !== paths.length) return { ok: false, error: "Invalid path.", output: "" };
    if (selected.length === 0) return { ok: false, error: "Select at least one file.", output: "" };
    args = into
     ? ["squash", "--from", revision ?? "@", "--into", into, "--", ...selected]
     : ["squash", "-r", revision ?? "@", "--", ...selected];
    break;
   }
   // Without `--into` the source squashes into its parent, which is the move
   // people reach for most: fold this change into the one below it.
   args = into
    ? ["squash", "--from", revision ?? "@", "--into", into]
    : ["squash", "-r", revision ?? "@"];
   break;
  }
  case "squash-hunks": {
   const into = target ? safeArg(target) : null;
   if (!into) return { ok: false, error: "Pick a destination revision.", output: "" };
   const file = paths && paths.length === 1 ? safeArg(paths[0]) : null;
   if (!file) return { ok: false, error: "Pick one file to squash.", output: "" };
   const wanted = (hunkIndexes ?? []).filter((index) => Number.isInteger(index) && index >= 0);
   if (wanted.length === 0) return { ok: false, error: "Select at least one hunk.", output: "" };
   const prepared = await prepareHunkSquash(root, revision ?? "@", into, file, wanted);
   if ("error" in prepared) return { ok: false, error: prepared.error, output: "" };
   args = prepared.args;
   cleanup = prepared.cleanup;
   break;
  }
  case "absorb":
   args = ["absorb", "--from", revision ?? "@"];
   break;
  case "insert-before":
  case "insert-after": {
   const flag = kind === "insert-before" ? "--insert-before" : "--insert-after";
   args = text ? ["new", flag, revision ?? "@", "-m", text] : ["new", flag, revision ?? "@"];
   break;
  }
  case "bookmark-advance": {
   const bookmark = name ? safeArg(name) : null;
   // Naming the bookmark targets it; without a name jj advances whichever
   // bookmarks are the closest ancestors of the destination.
   args = bookmark
    ? ["bookmark", "advance", bookmark, "--to", revision ?? "@"]
    : ["bookmark", "advance", "--to", revision ?? "@"];
   break;
  }
  case "push": {
   const bookmark = name ? safeArg(name) : null;
   // A named bookmark is pushed on its own; otherwise the tracked bookmarks go,
   // which is what a plain `git push` would have done.
   args = bookmark ? ["git", "push", "--bookmark", bookmark] : ["git", "push", "--tracked"];
   break;
  }
  default:
   return { ok: false, error: "Unsupported action.", output: "" };
 }

 try {
  const result = await runJj(args, root);
  return {
   ok: result.ok,
   error: result.ok ? null : result.stderr || "jj command failed.",
   output: (result.stdout || result.stderr).trim(),
  };
 } finally {
  cleanup?.();
 }
}
