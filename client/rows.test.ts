import assert from "node:assert/strict";
import type { JjDiffLine, JjFileDiff } from "../shared/contracts";
import { buildRows } from "./rows";

/** Side-by-side pairing is the part of the client a reader notices when it is
 *  wrong: a mismatched pair silently attributes one line's text to another. */

function line(kind: JjDiffLine["kind"], text: string, oldLine: number | null, newLine: number | null): JjDiffLine {
 return { kind, oldLine, newLine, tokens: [{ t: text, c: null }] };
}

function file(lines: JjDiffLine[]): JjFileDiff {
 return {
  path: "src/a.ts",
  previousPath: null,
  status: "modified",
  additions: lines.filter((entry) => entry.kind === "add").length,
  deletions: lines.filter((entry) => entry.kind === "remove").length,
  binary: false,
  hunks: [{ header: "@@ -1,4 +1,4 @@", oldStart: 1, newStart: 1, lines }],
 };
}

const text = (value: JjDiffLine | null) => value?.tokens.map((token) => token.t).join("") ?? null;

// --- balanced replacement pairs in order ----------------------------------
{
 const rows = buildRows(
  [
   file([
    line("context", "keep", 1, 1),
    line("remove", "old-a", 2, null),
    line("remove", "old-b", 3, null),
    line("add", "new-a", null, 2),
    line("add", "new-b", null, 3),
   ]),
  ],
  true,
 ).rows;

 const pairs = rows.filter((row) => row.kind === "split");
 assert.equal(pairs.length, 3, "one context row plus two paired rows");
 assert.equal(text(pairs[1].left), "old-a");
 assert.equal(text(pairs[1].right), "new-a");
 assert.equal(text(pairs[2].left), "old-b");
 assert.equal(text(pairs[2].right), "new-b");
}

// --- uneven counts leave a blank side, never a shifted one ----------------
{
 const rows = buildRows(
  [
   file([
    line("remove", "only-old", 1, null),
    line("add", "new-1", null, 1),
    line("add", "new-2", null, 2),
   ]),
  ],
  true,
 ).rows;

 const pairs = rows.filter((row) => row.kind === "split");
 assert.equal(pairs.length, 2);
 assert.equal(text(pairs[0].left), "only-old");
 assert.equal(text(pairs[0].right), "new-1");
 assert.equal(pairs[1].left, null, "the second row has no left side");
 assert.equal(text(pairs[1].right), "new-2");
}

// --- an addition-only block must not stall or drop lines ------------------
{
 const rows = buildRows(
  [file([line("context", "same", 1, 1), line("add", "extra", null, 2)])],
  true,
 ).rows;
 const pairs = rows.filter((row) => row.kind === "split");
 assert.equal(pairs.length, 2);
 assert.equal(pairs[1].left, null);
 assert.equal(text(pairs[1].right), "extra");
}

// --- unified mode emits one row per line, in order ------------------------
{
 const rows = buildRows(
  [file([line("context", "a", 1, 1), line("add", "b", null, 2), line("remove", "c", 2, null)])],
  false,
 ).rows;

 assert.equal(
  rows.filter((row) => row.kind === "split").length,
  0,
  "unified mode must not emit split rows",
 );
 const rendered = rows
  .filter((row) => row.kind === "line")
  .map((row) => (row.kind === "line" ? text(row.line) : null));
 assert.deepEqual(rendered, ["a", "b", "c"], "unified order follows the diff");
}

// --- file navigation indexes point at the header rows ---------------------
{
 const first = file([line("context", "a", 1, 1)]);
 const second = { ...file([line("add", "b", null, 1)]), path: "src/b.ts" };
 const { rows, fileRowIndex } = buildRows([first, second], false);

 assert.equal(fileRowIndex.get("src/a.ts"), 0);
 const secondIndex = fileRowIndex.get("src/b.ts");
 assert.ok(secondIndex !== undefined);
 const row = rows[secondIndex];
 assert.equal(row.kind, "file");
 assert.equal(row.kind === "file" ? row.file.path : null, "src/b.ts");
}

// --- binary and empty files still produce a navigable header --------------
{
 const binary: JjFileDiff = { ...file([]), path: "logo.png", binary: true };
 const { rows, fileRowIndex } = buildRows([binary], false);
 assert.equal(rows[0].kind, "file");
 assert.equal(rows[1].kind, "note");
 assert.equal(fileRowIndex.get("logo.png"), 0);

 // A file listed with no hunks at all is a rename or mode change.
 const unchanged: JjFileDiff = { ...file([]), path: "same.ts", hunks: [] };
 const unchangedRows = buildRows([unchanged], false).rows;
 assert.equal(unchangedRows[1].kind, "note");
}

console.log("rows.test.ts: all assertions passed");
