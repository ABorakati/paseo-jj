import { parsePatchFiles, processFile, type FileDiffMetadata } from "./vendor/pierre.js";
import type { JjFileDiff } from "../shared/contracts";
import { filePatch } from "./pierre-patch";

/** A file with no hunk for Pierre to parse still belongs in the list as its
 *  header: a binary file, or a rename with no content change. */
function headerOnly(file: JjFileDiff): FileDiffMetadata {
 return {
  name: file.path,
  ...(file.previousPath === null ? {} : { prevName: file.previousPath }),
  type:
   file.status === "added"
    ? "new"
    : file.status === "removed"
     ? "deleted"
     : file.status === "renamed"
      ? "rename-pure"
      : "change",
  hunks: [],
  splitLineCount: 0,
  unifiedLineCount: 0,
  isPartial: true,
  additionLines: [],
  deletionLines: [],
 };
}

/**
 * What Pierre renders for one file. Kept apart from the patch builder because
 * this is the only module in the diff surface that loads Pierre's runtime, which
 * arrives as the vendored bundle (see client/vendor/pierre.d.ts).
 */
export function parseFile(file: JjFileDiff): FileDiffMetadata {
 return parsePatchFiles(filePatch(file))[0]?.files[0] ?? headerOnly(file);
}

/**
 * A file this change added, with its text attached. Pierre loads the file pair
 * for an editor only when a file changed or was renamed, so an added file is
 * handed over already hydrated: an empty old side and the file as the new one.
 */
export function parseAddedFile(file: JjFileDiff, text: string): FileDiffMetadata {
 return (
  processFile(filePatch(file), {
   oldFile: { name: file.path, contents: "" },
   newFile: { name: file.path, contents: text },
  }) ?? headerOnly(file)
 );
}
