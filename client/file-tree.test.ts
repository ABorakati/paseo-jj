import assert from "node:assert/strict";
import type { JjFileDiff } from "../shared/contracts";
import { buildFileTree, orderFiles, type FileTreeRow } from "./file-tree";

/** The rail's orders and totals are what a reader navigates by: a file listed
 *  twice, ordered away from its diff header, or a folder total that misses a
 *  nested file all read as a broken panel. */

function file(
 path: string,
 additions = 1,
 deletions = 0,
 status: JjFileDiff["status"] = "modified",
): JjFileDiff {
 return { path, previousPath: null, status, additions, deletions, binary: false, hunks: [] };
}

const labels = (rows: FileTreeRow[]) =>
 rows.map((row) =>
  row.kind === "folder" ? `d:${row.label}@${row.depth}` : `f:${row.path}@${row.depth}`,
 );

// --- directories sort before files, then plain ASCII ----------------------
{
 const ordered = orderFiles([file("b.ts"), file("a/z.ts"), file("a/b.ts"), file("a.ts")]);
 assert.deepEqual(
  ordered.map((entry) => entry.path),
  ["a/b.ts", "a/z.ts", "a.ts", "b.ts"],
 );
}

// --- single-child chains compress, and keep the deepest path as identity ---
{
 const tree = buildFileTree([file("packages/app/src/x.ts"), file("lib/util.ts")], new Set());
 assert.deepEqual(labels(tree.rows), [
  "d:lib@0",
  "f:lib/util.ts@1",
  "d:packages/app/src@0",
  "f:packages/app/src/x.ts@1",
 ]);
 // A chain only merges while every level holds a single directory: `lib` holds
 // a file, so it stays its own row.
 assert.deepEqual(tree.folderPaths, ["lib", "packages/app/src"]);
}

// --- a level with a sibling directory does not compress -------------------
{
 const tree = buildFileTree([file("a/b/c.ts"), file("a/d.ts")], new Set());
 assert.deepEqual(labels(tree.rows), ["d:a@0", "d:b@1", "f:a/b/c.ts@2", "f:a/d.ts@1"]);
}

// --- collapsing hides descendants but keeps the folder's full totals ------
{
 const tree = buildFileTree(
  [file("a/b/one.ts", 3, 1), file("a/b/two.ts", 2, 4), file("c.ts")],
  new Set(["a/b"]),
 );
 assert.deepEqual(labels(tree.rows), ["d:a/b@0", "f:c.ts@0"]);
 const folder = tree.rows[0];
 assert.equal(folder.kind, "folder");
 assert.equal(folder.additions, 5);
 assert.equal(folder.deletions, 5);
}

// --- the diff order matches the rail order, collapsed or not --------------
{
 const files = [file("z.ts"), file("pkg/a/x.ts"), file("pkg/b/y.ts"), file("pkg/a/w.ts")];
 const orderedFiles = orderFiles(files);
 const fromTree = buildFileTree(files, new Set()).rows
  .filter((row) => row.kind === "file")
  .map((row) => row.path);
 assert.deepEqual(
  orderedFiles.map((entry) => entry.path),
  fromTree,
 );
 const collapsed = buildFileTree(files, new Set(["pkg/a"])).rows
  .filter((row) => row.kind === "file")
  .map((row) => row.path);
 assert.deepEqual(collapsed, ["pkg/b/y.ts", "z.ts"]);
}

console.log("file-tree.test.ts: all assertions passed");
