import assert from "node:assert/strict";
import { applyHunks, describeFile, parseGitDiff, shouldHighlight } from "./diff";
import { languageForPath, tokenizeLines } from "./tokenize";

/**
 * The property that matters most: whatever the parser does, joining a line's
 * tokens must reproduce the file's bytes. A diff that renders altered source is
 * worse than no diff at all, and highlighting is the step that could reflow it.
 */

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,5 +1,6 @@
 import { start } from "./server";
 
-const port = 3000;
+const port = 8080;
+const host = "127.0.0.1";
 export function main() {
-  start(port);
+  start(port, host);
 }
`;

const ADDED = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+export const one = 1;
+export const two = 2;
`;

const DELETED = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 4444444..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const gone = true;
-export const alsoGone = false;
`;

const RENAMED = `diff --git a/old/name.ts b/new/name.ts
similarity index 100%
rename from old/name.ts
rename to new/name.ts
`;

const BINARY = `diff --git a/logo.png b/logo.png
index 5555555..6666666 100644
Binary files a/logo.png and b/logo.png differ
`;

const NO_NEWLINE = `diff --git a/end.ts b/end.ts
--- a/end.ts
+++ b/end.ts
@@ -1 +1 @@
-const a = 1;
\\ No newline at end of file
+const a = 2;
\\ No newline at end of file
`;

const MULTI_HUNK = `diff --git a/big.ts b/big.ts
--- a/big.ts
+++ b/big.ts
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
@@ -20,3 +20,3 @@
 twenty
-twentyOne
+twentyone
 twentyTwo
`;

function tokensToText(line: { tokens: Array<{ t: string }> }): string {
 return line.tokens.map((token) => token.t).join("");
}

/** Two hunks where the first grows the file, so the second's offset matters. */
const GROWING = `diff --git a/grow.txt b/grow.txt
--- a/grow.txt
+++ b/grow.txt
@@ -1,3 +1,4 @@
 a
-b
+B
+B2
 c
@@ -10,3 +11,3 @@
-j
+J
 k
 l
`;

/** A hunk that only adds lines: its old side is empty, not a line. */
const INSERTED = `diff --git a/mid.txt b/mid.txt
--- a/mid.txt
+++ b/mid.txt
@@ -2,0 +3,2 @@
+added one
+added two
`;

/** A file emptied in place, which is not the same as a deleted file. */
const EMPTIED = `diff --git a/emptied.txt b/emptied.txt
--- a/emptied.txt
+++ b/emptied.txt
@@ -1,2 +0,0 @@
-a
-b
`;

// --- modified file --------------------------------------------------------
{
 const { files, truncated } = parseGitDiff(MODIFIED);
 assert.equal(truncated, false);
 assert.equal(files.length, 1);
 const file = describeFile(files[0], true);

 assert.equal(file.path, "src/app.ts");
 assert.equal(file.status, "modified");
 assert.equal(file.additions, 3);
 assert.equal(file.deletions, 2);

 const lines = file.hunks[0].lines;
 assert.equal(lines.length, 9, "context + changed lines in one hunk");

 // Line numbers: `const port = 3000;` is the third line of both sides.
 const removed = lines.find((line) => line.kind === "remove");
 assert.equal(removed?.oldLine, 3);
 assert.equal(removed?.newLine, null);
 const added = lines.find((line) => line.kind === "add");
 assert.equal(added?.newLine, 3);
 assert.equal(added?.oldLine, null);

 // Every line must reconstruct its source exactly.
 assert.equal(tokensToText(removed!), "const port = 3000;");
 assert.equal(tokensToText(added!), "const port = 8080;");

 // Rebuilding each side from the parsed lines must reproduce the file, which
 // validates line numbers and token text together.
 const rebuild = (side: "old" | "new") =>
  lines
   .filter((line) => (side === "old" ? line.kind !== "add" : line.kind !== "remove"))
   .map((line) => tokensToText(line))
   .join("\n");

 assert.equal(
  rebuild("old"),
  [
   'import { start } from "./server";',
   "",
   "const port = 3000;",
   "export function main() {",
   "  start(port);",
   "}",
  ].join("\n"),
 );
 assert.equal(
  rebuild("new"),
  [
   'import { start } from "./server";',
   "",
   "const port = 8080;",
   'const host = "127.0.0.1";',
   "export function main() {",
   "  start(port, host);",
   "}",
  ].join("\n"),
 );

 // Context lines advance both sides.
 const context = lines[lines.length - 1];
 assert.equal(context.kind, "context");
 assert.equal(tokensToText(context), "}");

 // Highlighting actually assigned a role to a TypeScript line.
 const keyworded = lines.find((line) => line.tokens.some((token) => token.c === "keyword"));
 assert.ok(keyworded, "a keyword token should be tokenized");
}

// --- added and deleted ----------------------------------------------------
{
 const added = describeFile(parseGitDiff(ADDED).files[0], true);
 assert.equal(added.status, "added");
 assert.equal(added.additions, 2);
 assert.equal(added.deletions, 0);
 assert.equal(added.hunks[0].lines[0].newLine, 1);
 assert.equal(added.hunks[0].lines[1].newLine, 2);
 assert.equal(tokensToText(added.hunks[0].lines[0]), "export const one = 1;");

 const deleted = describeFile(parseGitDiff(DELETED).files[0], true);
 assert.equal(deleted.status, "removed");
 assert.equal(deleted.additions, 0);
 assert.equal(deleted.deletions, 2);
 assert.equal(deleted.hunks[0].lines[0].oldLine, 1);
 assert.equal(tokensToText(deleted.hunks[0].lines[1]), "export const alsoGone = false;");
}

// --- rename and binary ----------------------------------------------------
{
 const renamed = describeFile(parseGitDiff(RENAMED).files[0], true);
 assert.equal(renamed.status, "renamed");
 assert.equal(renamed.path, "new/name.ts");
 assert.equal(renamed.previousPath, "old/name.ts");
 assert.equal(renamed.hunks.length, 0);

 const binary = describeFile(parseGitDiff(BINARY).files[0], true);
 assert.equal(binary.binary, true);
 assert.equal(binary.path, "logo.png");
}

// --- no-newline marker is not a line -------------------------------------
{
 const file = describeFile(parseGitDiff(NO_NEWLINE).files[0], true);
 assert.equal(file.hunks[0].lines.length, 2, "the \\\\ marker is not a diff line");
 assert.equal(file.additions, 1);
 assert.equal(file.deletions, 1);
}

// --- multiple hunks -------------------------------------------------------
{
 const file = describeFile(parseGitDiff(MULTI_HUNK).files[0], true);
 assert.equal(file.hunks.length, 2);
 assert.equal(file.hunks[1].oldStart, 20);
 assert.equal(file.hunks[1].lines[0].oldLine, 20);
 assert.equal(file.hunks[1].lines[1].oldLine, 21);
 assert.equal(file.hunks[1].lines[1].newLine, null);
}

// --- empty diff -----------------------------------------------------------
{
 const { files } = parseGitDiff("");
 assert.equal(files.length, 0);
}

// --- highlighting degrades instead of throwing ---------------------------
{
 const lines = ["const a = 1;", "const b = 2;"];
 assert.equal(tokenizeLines(lines, null).length, 2);
 assert.equal(tokenizeLines(lines, "nope-not-a-language").length, 2);
 assert.deepEqual(tokenizeLines([], "typescript"), []);

 // Unknown extension means no language, and the text still round-trips.
 assert.equal(languageForPath("Makefile"), null);
 assert.equal(languageForPath("src/main.zig"), null);
 assert.equal(languageForPath("src/main.ts"), "typescript");
 assert.equal(languageForPath("a/b/c.PY"), "python");

 const plain = tokenizeLines(["hello <world> & 'friends'"], "typescript");
 assert.equal(plain[0].map((token) => token.t).join(""), "hello <world> & 'friends'");
}

// --- multi-line constructs keep their context ----------------------------
{
 // Tokenizing line by line would see an unterminated block comment here.
 const block = ["/* start", "   still comment", "   end */", "const x = 1;"];
 const tokens = tokenizeLines(block, "javascript");
 assert.equal(tokens.length, 4);
 assert.equal(tokens.map((line) => line.map((token) => token.t).join("")).join("\n"), block.join("\n"));
 assert.ok(
  tokens[1].every((token) => token.c === "comment" || token.c === null),
  "the middle line of a block comment must stay a comment",
 );
}

assert.equal(shouldHighlight(10), true);
assert.equal(shouldHighlight(10_000), false);

// --- applying selected hunks ---------------------------------------------
// The hunk move hands jj a file whose whole content it adopts, so this is the
// step that decides what actually moves: a wrong offset here writes the wrong
// bytes into the destination revision.
{
 const before = [
  "one",
  "two",
  "three",
  ...Array.from({ length: 16 }, (_, index) => `filler${index + 4}`),
  "twenty",
  "twentyOne",
  "twentyTwo",
 ];
 const text = `${before.join("\n")}\n`;
 const withAt = (at: number, value: string) =>
  `${before.map((entry, index) => (index === at - 1 ? value : entry)).join("\n")}\n`;

 const multi = parseGitDiff(MULTI_HUNK).files[0];
 assert.equal(multi.hunks.length, 2, "the fixture carries two hunks");

 assert.equal(applyHunks(text, multi.hunks, [0]), withAt(2, "TWO"), "only the first hunk moves");
 assert.equal(applyHunks(text, multi.hunks, [1]), withAt(21, "twentyone"), "only the second hunk moves");
 assert.equal(applyHunks(text, multi.hunks, []), text, "no selection leaves the text alone");
 assert.equal(applyHunks(text, multi.hunks, [5]), null, "an index past the end is refused");
 assert.equal(
  applyHunks(text.replace("twenty", "moved"), multi.hunks, [1]),
  null,
  "text that no longer matches the hunk's own lines is refused",
 );

 // The later hunk sits at line 10 and the earlier one adds a line, so the two
 // only both land if the offsets are resolved back to front.
 const grow = parseGitDiff(GROWING).files[0];
 assert.equal(grow.hunks.length, 2);
 assert.equal(
  applyHunks(`${["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].join("\n")}\n`, grow.hunks, [0, 1]),
  `${["a", "B", "B2", "c", "d", "e", "f", "g", "h", "i", "J", "k", "l"].join("\n")}\n`,
  "a hunk that grows the file must not shift the hunks above it",
 );

 // A hunk with no lines on the old side names the line it adds after.
 const inserted = parseGitDiff(INSERTED).files[0];
 assert.equal(applyHunks("a\nb\nc\n", inserted.hunks, [0]), "a\nb\nadded one\nadded two\nc\n");

 const added = parseGitDiff(ADDED).files[0];
 assert.equal(applyHunks("", added.hunks, [0]), "export const one = 1;\nexport const two = 2;");

 const emptied = parseGitDiff(EMPTIED).files[0];
 assert.equal(applyHunks("a\nb\n", emptied.hunks, [0]), "", "emptying a file leaves no bytes");
}

console.log("diff.test.ts: all assertions passed");
