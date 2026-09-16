import type { JjDiffLine, JjFileDiff } from "../shared/contracts";

/**
 * The diff the panel renders is built from the structured hunks `server/diff.ts`
 * already parsed out of `jj diff --git`, and handed back to Pierre as a patch in
 * the same git format. That round trip is what keeps a rendered hunk and a jj
 * hunk the same hunk: Pierre parses the hunks back in order, so hunk *i* of a
 * file is hunk *i* of the source diff.
 */

/**
 * jj hands over syntax tokens rather than text, and the tokens concatenate back
 * to the original line, so the patch body is recovered from them.
 */
function bodyLine(line: JjDiffLine): string {
 const text = line.tokens.map((token) => token.t).join("");
 if (line.kind === "add") return `+${text}`;
 if (line.kind === "remove") return `-${text}`;
 return ` ${text}`;
}

/**
 * One git-format diff for one file, which is the input Pierre parses. The hunk
 * headers are reused verbatim: recomputing them from the line numbers would let
 * a header disagree with the lines it introduces.
 */
export function filePatch(file: JjFileDiff): string {
 const oldPath = file.previousPath ?? file.path;
 const newPath = file.path;
 const lines = [`diff --git a/${oldPath} b/${newPath}`];
 if (file.status === "added") lines.push("new file mode 100644");
 if (file.status === "removed") lines.push("deleted file mode 100644");
 if (file.status === "renamed" || file.status === "copied") {
  lines.push(`rename from ${oldPath}`, `rename to ${newPath}`);
  // With no hunk to say it, this line is the only signal that the file was
  // renamed rather than changed.
  if (file.hunks.length === 0) lines.push("similarity index 100%");
 }
 lines.push(file.status === "added" ? "--- /dev/null" : `--- a/${oldPath}`);
 lines.push(file.status === "removed" ? "+++ /dev/null" : `+++ b/${newPath}`);
 for (const hunk of file.hunks) {
  lines.push(hunk.header);
  for (const line of hunk.lines) lines.push(bodyLine(line));
 }
 return `${lines.join("\n")}\n`;
}

/** What a file header says about a file the diff itself cannot show. */
export function noteFor(file: JjFileDiff): string | null {
 if (file.binary) return "Binary file — no text diff.";
 if (file.hunks.length > 0) return null;
 return file.status === "renamed" ? "Renamed with no content change." : "No content changes.";
}

/**
 * One file's text, recovered from the diff that reads the whole file: a range
 * from the empty root revision to the revision being read shows every line as an
 * addition, so the new side is the file. Returns null when the diff does not
 * describe exactly one text file, which is how a missing path and a binary file
 * are told apart from an empty one.
 */
export function wholeFileText(files: JjFileDiff[]): string | null {
 if (files.length !== 1) return null;
 const file = files[0];
 if (file.binary) return null;
 const rows = file.hunks.flatMap((hunk) => hunk.lines);
 if (rows.some((row) => row.kind !== "add")) return null;
 if (rows.length === 0) return "";
 return `${rows.map((row) => row.tokens.map((token) => token.t).join("")).join("\n")}\n`;
}
