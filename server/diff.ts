import type { JjDiffHunk, JjDiffLine, JjFileDiff } from "../shared/contracts";
import { languageForPath, tokenizeLines } from "./tokenize";
import { normalizePath } from "./jj";

/** Caps keep one enormous diff from stalling the subprocess and the renderer. */
const MAX_FILES = 200;
const MAX_TOTAL_LINES = 8000;
const MAX_HIGHLIGHT_LINES = 3000;

interface RawLine {
 kind: JjDiffLine["kind"];
 content: string;
}

interface RawHunk {
 header: string;
 oldStart: number;
 newStart: number;
 lines: RawLine[];
}

interface RawFile {
 path: string;
 previousPath: string | null;
 status: JjFileDiff["status"];
 binary: boolean;
 hunks: RawHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function stripPrefix(path: string): string | null {
 if (path === "/dev/null") return null;
 if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
 return path;
}

/** Paths in `diff --git a/x b/y` are ambiguous when they contain spaces, so the
 *  `---`/`+++` lines are preferred and this is only a fallback. */
function pathsFromGitHeader(line: string): { oldPath: string | null; newPath: string | null } {
 const rest = line.slice("diff --git ".length);
 const quoted = /^"(.*)" "(.*)"$/.exec(rest);
 if (quoted) return { oldPath: stripPrefix(quoted[1]), newPath: stripPrefix(quoted[2]) };
 const halves = rest.split(" b/");
 if (halves.length === 2) return { oldPath: stripPrefix(halves[0]), newPath: stripPrefix(`b/${halves[1]}`) };
 return { oldPath: null, newPath: stripPrefix(rest) };
}

/** Parse `jj diff --git` output into file entries. Token highlighting is added
 *  afterwards, per hunk side, so multi-line constructs colour correctly. */
export function parseGitDiff(text: string): { files: RawFile[]; truncated: boolean } {
 const lines = text.split("\n");
 const files: RawFile[] = [];
 let current: RawFile | null = null;
 let hunk: RawHunk | null = null;
 let totalLines = 0;
 let truncated = false;

 const finishHunk = () => {
  if (current && hunk) current.hunks.push(hunk);
  hunk = null;
 };
 const finishFile = () => {
  finishHunk();
  if (current) files.push(current);
  current = null;
 };

 for (const line of lines) {
  if (line.startsWith("diff --git ")) {
   finishFile();
   if (files.length >= MAX_FILES) {
    truncated = true;
    break;
   }
   const { oldPath, newPath } = pathsFromGitHeader(line);
   current = {
    path: newPath ?? oldPath ?? "unknown",
    previousPath: null,
    status: "modified",
    binary: false,
    hunks: [],
   };
   continue;
  }
  if (!current) continue;

  if (line.startsWith("new file mode")) {
   current.status = "added";
   continue;
  }
  if (line.startsWith("deleted file mode")) {
   current.status = "removed";
   continue;
  }
  if (line.startsWith("rename from ")) {
   current.status = "renamed";
   current.previousPath = line.slice("rename from ".length);
   continue;
  }
  if (line.startsWith("rename to ")) {
   current.status = "renamed";
   current.path = line.slice("rename to ".length);
   continue;
  }
  if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
   current.binary = true;
   continue;
  }
  if (line.startsWith("--- ")) {
   const oldPath = stripPrefix(line.slice(4).replace(/\t.*$/, "").trimEnd());
   if (oldPath === null) current.status = "added";
   continue;
  }
  if (line.startsWith("+++ ")) {
   const newPath = stripPrefix(line.slice(4).replace(/\t.*$/, "").trimEnd());
   if (newPath === null) current.status = "removed";
   else current.path = newPath;
   continue;
  }

  const header = HUNK_HEADER.exec(line);
  if (header) {
   finishHunk();
   hunk = {
    header: line,
    oldStart: Number(header[1]),
    newStart: Number(header[2]),
    lines: [],
   };
   continue;
  }

  if (!hunk) continue;

  // "\\ No newline at end of file" annotates the previous line; it is not a
  // line of either side.
  if (line.startsWith("\\")) continue;

  const marker = line[0];
  if (marker === "+") {
   hunk.lines.push({ kind: "add", content: line.slice(1) });
  } else if (marker === "-") {
   hunk.lines.push({ kind: "remove", content: line.slice(1) });
  } else if (marker === " ") {
   hunk.lines.push({ kind: "context", content: line.slice(1) });
  } else if (line === "") {
   // An empty line inside a hunk is a context line with its space stripped
   // by some producers; jj always writes the space, so this is a hunk end.
   continue;
  } else {
   continue;
  }

  totalLines += 1;
  if (totalLines > MAX_TOTAL_LINES) {
   truncated = true;
   break;
  }
 }
 finishFile();

 return { files, truncated };
}

/** Replace a raw file's plain line content with highlighted tokens, assigning
 *  old/new line numbers as it goes. */
export function describeFile(file: RawFile, highlight: boolean): JjFileDiff {
 const language = languageForPath(file.path);
 const hunks: JjDiffHunk[] = [];
 let additions = 0;
 let deletions = 0;

 for (const raw of file.hunks) {
  const oldSide = raw.lines.filter((line) => line.kind !== "add").map((line) => line.content);
  const newSide = raw.lines.filter((line) => line.kind !== "remove").map((line) => line.content);
  const oldTokens = highlight ? tokenizeLines(oldSide, language) : oldSide.map(plain);
  const newTokens = highlight ? tokenizeLines(newSide, language) : newSide.map(plain);

  let oldCursor = 0;
  let newCursor = 0;
  const outLines: JjDiffLine[] = [];
  for (const line of raw.lines) {
   if (line.kind === "add") {
    outLines.push({
     kind: "add",
     oldLine: null,
     newLine: raw.newStart + newCursor,
     tokens: newTokens[newCursor] ?? plain(line.content),
    });
    newCursor += 1;
    additions += 1;
    continue;
   }
   if (line.kind === "remove") {
    outLines.push({
     kind: "remove",
     oldLine: raw.oldStart + oldCursor,
     newLine: null,
     tokens: oldTokens[oldCursor] ?? plain(line.content),
    });
    oldCursor += 1;
    deletions += 1;
    continue;
   }
   outLines.push({
    kind: "context",
    oldLine: raw.oldStart + oldCursor,
    newLine: raw.newStart + newCursor,
    tokens: newTokens[newCursor] ?? plain(line.content),
   });
   oldCursor += 1;
   newCursor += 1;
  }

  hunks.push({
   header: raw.header,
   oldStart: raw.oldStart,
   newStart: raw.newStart,
   lines: outLines,
  });
 }

 return {
  path: normalizePath(file.path),
  previousPath: file.previousPath === null ? null : normalizePath(file.previousPath),
  status: file.status,
  additions,
  deletions,
  binary: file.binary,
  hunks,
 };
}

function plain(content: string): JjDiffLine["tokens"] {
 return content.length > 0 ? [{ t: content, c: null }] : [];
}

/** Highlighting a very large diff costs more than it is worth, so past the cap
 *  the diff still renders, just without colour. */
export function shouldHighlight(totalLines: number): boolean {
 return totalLines <= MAX_HIGHLIGHT_LINES;
}
