import assert from "node:assert/strict";
import type { JjDiffHunk, JjFileDiff } from "../shared/contracts";
import { filePatch, noteFor, wholeFileText } from "./pierre-patch";

const line = (kind: "add" | "remove" | "context", text: string) => ({
 kind,
 oldLine: kind === "add" ? null : 1,
 newLine: kind === "remove" ? null : 1,
 tokens: text.length > 0 ? [{ t: text, c: null }] : [],
});

const hunk = (
 header: string,
 oldStart: number,
 newStart: number,
 lines: JjDiffHunk["lines"],
): JjDiffHunk => ({ header, oldStart, newStart, lines });

const MODIFIED: JjFileDiff = {
 path: "client/panel.tsx",
 previousPath: null,
 status: "modified",
 additions: 2,
 deletions: 1,
 binary: false,
 hunks: [
  hunk("@@ -1,3 +1,4 @@", 1, 1, [
   line("context", "first"),
   line("remove", "old"),
   line("add", "new"),
   line("context", "last"),
  ]),
  hunk("@@ -20,2 +21,3 @@ function tail()", 20, 21, [line("context", "keep"), line("add", "extra")]),
 ],
};

const ADDED: JjFileDiff = {
 path: "client/added.ts",
 previousPath: null,
 status: "added",
 additions: 1,
 deletions: 0,
 binary: false,
 hunks: [hunk("@@ -0,0 +1,1 @@", 0, 1, [line("add", "value")])],
};

const REMOVED: JjFileDiff = {
 path: "client/removed.ts",
 previousPath: null,
 status: "removed",
 additions: 0,
 deletions: 1,
 binary: false,
 hunks: [hunk("@@ -1,1 +0,0 @@", 1, 0, [line("remove", "value")])],
};

const RENAMED: JjFileDiff = {
 path: "client/new-name.ts",
 previousPath: "client/old-name.ts",
 status: "renamed",
 additions: 0,
 deletions: 0,
 binary: false,
 hunks: [],
};

const BINARY: JjFileDiff = {
 path: "assets/logo.png",
 previousPath: null,
 status: "modified",
 additions: 0,
 deletions: 0,
 binary: true,
 hunks: [],
};

/**
 * The hunk a control names is the hunk jj emitted, which holds because the
 * patch carries jj's headers and bodies through in order — Pierre reads them
 * back in that same order.
 */
const patch = filePatch(MODIFIED);
const patchLines = patch.split("\n");
assert.equal(patchLines[0], "diff --git a/client/panel.tsx b/client/panel.tsx");
assert.deepEqual(
 patchLines.filter((row) => row.startsWith("@@ ")),
 MODIFIED.hunks.map((source) => source.header),
 "one verbatim header per hunk, in jj's order",
);
assert.ok(
 patch.includes(["@@ -1,3 +1,4 @@", " first", "-old", "+new", " last"].join("\n")),
 "the hunk body survives, markers included",
);
assert.ok(patch.includes("@@ -20,2 +21,3 @@ function tail()"), "trailing hunk context survives");

/** A file that exists on one side only says so, or Pierre reads it as a change
 *  to a file both sides have. */
assert.ok(filePatch(ADDED).includes("--- /dev/null\n+++ b/client/added.ts\n"));
assert.ok(filePatch(REMOVED).includes("--- a/client/removed.ts\n+++ /dev/null\n"));

/** A rename has no hunk to carry its path, so the header lines have to. */
const renamedPatch = filePatch(RENAMED);
assert.ok(renamedPatch.startsWith("diff --git a/client/old-name.ts b/client/new-name.ts\n"));
assert.ok(renamedPatch.includes("rename from client/old-name.ts\nrename to client/new-name.ts\n"));
assert.ok(renamedPatch.includes("similarity index 100%"));

/** Paths with a space are ambiguous in `diff --git a/x b/y`; the file headers
 *  carry them, so the patch must not quote or truncate either side. */
const spaced = filePatch({ ...MODIFIED, path: "docs/my file.md" });
assert.ok(spaced.includes("+++ b/docs/my file.md\n"));

assert.equal(noteFor(MODIFIED), null);
assert.equal(noteFor(ADDED), null);
assert.equal(noteFor(RENAMED), "Renamed with no content change.");
assert.equal(noteFor(BINARY), "Binary file — no text diff.");
assert.equal(noteFor({ ...MODIFIED, hunks: [] }), "No content changes.");

/**
 * The text an edit writes back comes from the whole-file read. It has to be the
 * file byte for byte, because the server checks the write against it.
 */
const wholeFile = {
 ...ADDED,
 path: "docs/readme.md",
 hunks: [
  hunk("@@ -0,0 +1,3 @@", 0, 1, [
   { ...line("add", "first line"), newLine: 1 },
   { ...line("add", "second line"), newLine: 2 },
   { ...line("add", "third line"), newLine: 3 },
  ]),
 ],
};
assert.equal(wholeFileText([wholeFile]), "first line\nsecond line\nthird line\n", "tokens rejoin into the file's text");
assert.equal(wholeFileText([]), null, "no file in the read means no text");
assert.equal(wholeFileText([ADDED, REMOVED]), null, "a read of more than one file is not a file");
assert.equal(wholeFileText([BINARY]), null, "a binary file has no text to read");
assert.equal(wholeFileText([{ ...wholeFile, hunks: [] }]), "", "an empty file reads as empty text");
assert.equal(
 wholeFileText([
  { ...wholeFile, hunks: [hunk("@@ -1,2 +1,2 @@", 1, 1, [line("context", "kept"), { ...line("add", "added"), newLine: 2 }])] },
 ]),
 null,
 "a partial diff is not the whole file",
);

console.log("client/pierre-patch.test.ts: all assertions passed");
