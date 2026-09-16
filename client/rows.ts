import type { JjDiffHunk, JjDiffLine, JjFileDiff } from "../shared/contracts";

export type DiffRow =
 | { kind: "file"; key: string; file: JjFileDiff; fileIndex: number }
 | { kind: "hunk"; key: string; header: string }
 | { kind: "line"; key: string; line: JjDiffLine }
 | { kind: "split"; key: string; left: JjDiffLine | null; right: JjDiffLine | null }
 | { kind: "note"; key: string; text: string };

export interface DiffRows {
 rows: DiffRow[];
 /** Path to the index of its header row, for list navigation. */
 fileRowIndex: Map<string, number>;
}

/**
 * Pair a hunk's removed and added lines index by index, which is what a
 * side-by-side view shows. Removed lines always precede the added lines that
 * replace them in a unified diff, so consuming each run is enough.
 */
function pairHunk(hunk: JjDiffHunk): Array<{ left: JjDiffLine | null; right: JjDiffLine | null }> {
 const paired: Array<{ left: JjDiffLine | null; right: JjDiffLine | null }> = [];
 const lines = hunk.lines;
 let index = 0;

 while (index < lines.length) {
  const line = lines[index];
  if (line.kind === "context") {
   paired.push({ left: line, right: line });
   index += 1;
   continue;
  }

  const removed: JjDiffLine[] = [];
  while (index < lines.length && lines[index].kind === "remove") {
   removed.push(lines[index]);
   index += 1;
  }
  const added: JjDiffLine[] = [];
  while (index < lines.length && lines[index].kind === "add") {
   added.push(lines[index]);
   index += 1;
  }
  if (removed.length === 0 && added.length === 0) {
   index += 1;
   continue;
  }

  const span = Math.max(removed.length, added.length);
  for (let offset = 0; offset < span; offset += 1) {
   paired.push({ left: removed[offset] ?? null, right: added[offset] ?? null });
  }
 }

 return paired;
}

/** Flatten files into the rows one virtualized list renders. A single list
 *  keeps every file in one scroll container, the way a review surface reads. */
export function buildRows(files: JjFileDiff[], split: boolean): DiffRows {
 const rows: DiffRow[] = [];
 const fileRowIndex = new Map<string, number>();

 files.forEach((file, fileIndex) => {
  fileRowIndex.set(file.path, rows.length);
  rows.push({ kind: "file", key: `f${fileIndex}`, file, fileIndex });

  if (file.binary) {
   rows.push({ kind: "note", key: `f${fileIndex}:bin`, text: "Binary file — no text diff." });
   return;
  }
  if (file.hunks.length === 0) {
   rows.push({
    kind: "note",
    key: `f${fileIndex}:none`,
    text:
     file.status === "renamed"
      ? "Renamed with no content change."
      : "No content changes.",
   });
   return;
  }

  file.hunks.forEach((hunk, hunkIndex) => {
   rows.push({ kind: "hunk", key: `f${fileIndex}:h${hunkIndex}`, header: hunk.header });
   if (!split) {
    hunk.lines.forEach((line, lineIndex) => {
     rows.push({ kind: "line", key: `f${fileIndex}:h${hunkIndex}:l${lineIndex}`, line });
    });
    return;
   }
   pairHunk(hunk).forEach((pair, pairIndex) => {
    rows.push({
     kind: "split",
     key: `f${fileIndex}:h${hunkIndex}:p${pairIndex}`,
     left: pair.left,
     right: pair.right,
    });
   });
  });
 });

 return { rows, fileRowIndex };
}
