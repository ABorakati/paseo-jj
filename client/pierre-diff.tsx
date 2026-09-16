import { CodeView, EditProvider, Editor } from "./vendor/pierre.js";
import type {
 CodeViewHandle,
 CodeViewItem,
 EditCompletionDecision,
 EditorFactory,
 FileDiffEditCompleteEvent,
 FileEditCompleteEvent,
} from "./vendor/pierre.js";
import type { CSSProperties, Ref } from "react";
import { memo, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import type { JjFileDiff } from "../shared/contracts";
import type { DiffPalette } from "./palette";
import { noteFor } from "./pierre-patch";
import { parseFile } from "./pierre-parse";

/**
 * What a hunk control asks for. `file` is the path exactly as `JjFileDiff.path`
 * carries it, and `hunkIndex` counts hunks in the parsed diff, in the order jj
 * emitted them — not a rendered row. Both name the same hunk the server parses
 * out of `jj diff`, so a caller can hand the pair straight to a jj command.
 */
export interface HunkActionInput {
 file: string;
 hunkIndex: number;
 kind: "accept" | "reject";
}

/** The panel drives the diff list through this, the way it used the FlatList. */
export interface PierreDiffHandle {
 scrollToFile(path: string): void;
}

/**
 * Reading and writing one working-copy file, which is what an inline edit
 * needs. The panel owns both because it owns the RPCs: the diff itself carries
 * only hunks, so the file's text has to be read before it can be written back.
 */
export interface FileEditAccess {
 /** Both sides of the file's text. `oldText` is the version the diff shows on
  *  its left, which the editor diffs the edit against. */
 read(path: string): Promise<{ oldText: string; newText: string }>;
 /** Writes the edited text. `expected` is the `newText` of the read that
  *  produced it, so a write built on a stale read is refused rather than
  *  overwriting what an agent wrote meanwhile. */
 write(input: {
  path: string;
  content: string;
  expected: string;
 }): Promise<{ ok: boolean; error: string | null }>;
}

interface PierreDiffViewProps {
 files: JjFileDiff[];
 split: boolean;
 palette: DiffPalette;
 /** Omitted outside the working copy, where a revert has nothing to undo. */
 onRevertFile?: (path: string) => void;
 onHunkAction?: (input: HunkActionInput) => void;
 /** Omitted outside the working copy: the panel edits the files it can write. */
 edit?: FileEditAccess;
 handleRef?: Ref<PierreDiffHandle>;
}

type EditEvent =
 | FileEditCompleteEvent<undefined, undefined>
 | FileDiffEditCompleteEvent<undefined, undefined>;

const NOTE_STYLE: CSSProperties = { fontSize: 11, opacity: 0.75 };
const HUNK_ROW_STYLE: CSSProperties = { display: "flex", gap: 2, alignItems: "center" };
const HUNK_LABEL_STYLE: CSSProperties = { fontSize: 11, opacity: 0.75 };

/**
 * The editor works on a file pair, and Pierre hydrates a patch-parsed diff from
 * one only when the file changed or was renamed. A file this change added or
 * removed has no pair to build, so the header says that instead of offering a
 * control that would do nothing.
 */
function editBlocker(file: JjFileDiff): string | null {
 if (file.binary) return "Binary file — no text diff.";
 if (file.status === "removed") return "Deleted in this change — nothing to edit.";
 if (file.status === "added") return "New file — the editor opens files this change modified.";
 if (file.hunks.length === 0) return "No content changes.";
 return null;
}

/**
 * The diff surface. Pierre owns rendering, layout and highlighting; this module
 * owns what the panel needs on top: which jj file a rendered item is, the
 * per-hunk controls, and the inline edit that writes back through the panel.
 */
export const PierreDiffView = memo(function PierreDiffView({
 files,
 split,
 palette,
 onRevertFile,
 onHunkAction,
 edit,
 handleRef,
}: PierreDiffViewProps) {
 const viewRef = useRef<CodeViewHandle<undefined, undefined>>(null);
 /** The file whose text is open in the editor, if any. */
 const [editing, setEditing] = useState<string | null>(null);
 /**
  * Bumped whenever an edit settles. The item version is what CodeView compares
  * to decide an item's value changed, so this is what drops the edited text and
  * re-reads the file after a save or a refusal.
  */
 const [epoch, setEpoch] = useState(0);
 /** The text each read returned, which is what a write is checked against. */
 const readText = useRef(new Map<string, string>());
 /** Whether the session that is ending asked to be written. */
 const saving = useRef(false);

 const items = useMemo<CodeViewItem<undefined>[]>(
  () =>
   files.map((file) => {
    const open = editing === file.path;
    return {
     // The path is the item id, which is what the file tree rail scrolls to.
     id: file.path,
     type: "diff" as const,
     // CodeView takes an item's value as changed when its version changes, and
     // the edit flag is one of those values: opening or closing the editor has
     // to move the version, or the item keeps whatever mode it was mounted in.
     version: epoch + (open ? 1 : 0),
     edit: edit !== undefined && open && editBlocker(file) === null,
     fileDiff: parseFile(file),
    };
   }),
  [files, edit, editing, epoch],
 );

 const sources = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);

 const loadDiffFiles = useCallback(
  async (fileDiff: { name: string }) => {
   if (edit === undefined) throw new Error("This diff is read-only.");
   const sides = await edit.read(fileDiff.name);
   readText.current.set(fileDiff.name, sides.newText);
   return {
    oldFile: { name: fileDiff.name, contents: sides.oldText },
    newFile: { name: fileDiff.name, contents: sides.newText },
   };
  },
  [edit],
 );

 const options = useMemo(
  () => ({
   diffStyle: split ? ("split" as const) : ("unified" as const),
   theme: palette.isDark ? "pierre-dark" : "pierre-light",
   // The diff arrives as hunks, so the editor can only be opened once Pierre
   // has the file pair this hands it.
   loadDiffFiles: edit === undefined ? undefined : loadDiffFiles,
  }),
  [split, palette.isDark, edit, loadDiffFiles],
 );

 const createEditor = useCallback<EditorFactory<undefined, undefined>>(
  (type, editorOptions, editStateKey) => new Editor(type, editorOptions, editStateKey),
  [],
 );

 const finishEdit = useCallback(
  (path: string, contents: string | undefined) => {
   const wantsWrite = saving.current;
   saving.current = false;
   setEditing(null);
   if (!wantsWrite || edit === undefined || contents === undefined) return;
   void edit
    .write({ path, content: contents, expected: readText.current.get(path) ?? "" })
    .finally(() => setEpoch((value) => value + 1));
  },
  [edit],
 );

 const onItemEditComplete = useCallback(
  function completeItemEdit(event: EditEvent, item: CodeViewItem<undefined>): EditCompletionDecision {
   if (!("newFile" in event) || event.newFile === null) {
    // A file item, or a deleted file: there is no new text to write.
    setEditing(null);
    saving.current = false;
    return "reject";
   }
   const path = item.type === "diff" ? item.fileDiff.name : item.file.name;
   const wantsWrite = saving.current;
   finishEdit(path, event.newFile.contents);
   return wantsWrite ? "accept" : "reject";
  },
  [finishEdit],
 );

 const headerStyle = useMemo<CSSProperties>(
  () => ({
   display: "flex",
   flexWrap: "wrap",
   gap: 6,
   alignItems: "center",
   justifyContent: "flex-end",
   fontFamily: "system-ui, sans-serif",
   color: palette.filePath,
  }),
  [palette.filePath],
 );

 const buttonStyle = useMemo<CSSProperties>(
  () => ({
   fontSize: 11,
   lineHeight: "16px",
   padding: "1px 5px",
   borderRadius: 4,
   border: `1px solid ${palette.splitDivider}`,
   background: palette.contextRow,
   color: palette.filePathMuted,
   cursor: "pointer",
  }),
  [palette.splitDivider, palette.contextRow, palette.filePathMuted],
 );

 /**
  * The file header is the one strip Pierre leaves to the host, so it carries
  * what the diff cannot say for itself: the per-file revert, the inline edit,
  * and one control per hunk.
  */
 const renderHeaderMetadata = useCallback(
  (item: CodeViewItem<undefined>) => {
   if (item.type !== "diff") return null;
   const file = item.fileDiff;
   const source = sources.get(file.name);
   if (source === undefined) return null;
   const blocker = editBlocker(source);
   const canRevert = onRevertFile !== undefined;
   const open = editing === file.name;
   // What the header cannot offer is what it explains: the note a file with no
   // hunks carries and the reason an edit cannot be opened are the same
   // sentence for a binary file, so only one of them is shown.
   const note = edit !== undefined && blocker !== null ? blocker : noteFor(source);

   return (
    <div style={headerStyle}>
     {note === null ? null : <span style={NOTE_STYLE}>{note}</span>}
     {canRevert ? (
      <button
       type="button"
       style={{ ...buttonStyle, color: palette.removedCount }}
       aria-label={`Discard changes to ${file.name}`}
       onClick={() => onRevertFile?.(file.name)}
      >
       Discard
      </button>
     ) : null}
     {edit === undefined || blocker !== null ? null : open ? (
      <>
       <button
        type="button"
        style={{ ...buttonStyle, borderColor: palette.addedCount, color: palette.addedCount }}
        title={`Write ${file.name} back to the working copy`}
        aria-label={`Save changes to ${file.name}`}
        onClick={() => {
         saving.current = true;
         setEditing(null);
        }}
       >
        Save
       </button>
       <button
        type="button"
        style={buttonStyle}
        title={`Leave ${file.name} as it is on disk`}
        aria-label={`Cancel changes to ${file.name}`}
        onClick={() => {
         saving.current = false;
         setEditing(null);
        }}
       >
        Cancel
       </button>
      </>
     ) : (
      <button
       type="button"
       style={buttonStyle}
       title={`Type in ${file.name} and write it back to the working copy`}
       aria-label={`Edit ${file.name} in the panel`}
       onClick={() => {
        saving.current = false;
        setEditing(file.name);
       }}
      >
       Edit
      </button>
     )}
     {onHunkAction === undefined
      ? null
      : file.hunks.map((hunk, hunkIndex) => (
       <span key={hunk.hunkSpecs ?? hunkIndex} style={HUNK_ROW_STYLE}>
        <span style={HUNK_LABEL_STYLE}>hunk {hunkIndex + 1}</span>
        <button
         type="button"
         style={buttonStyle}
         title={`Keep hunk ${hunkIndex + 1} in this revision`}
         aria-label={`Accept hunk ${hunkIndex + 1} of ${file.name}`}
         onClick={() => onHunkAction({ file: file.name, hunkIndex, kind: "accept" })}
        >
         keep
        </button>
        <button
         type="button"
         style={buttonStyle}
         title={`Move hunk ${hunkIndex + 1} out of this revision and into its parent`}
         aria-label={`Reject hunk ${hunkIndex + 1} of ${file.name}`}
         onClick={() => onHunkAction({ file: file.name, hunkIndex, kind: "reject" })}
        >
         → parent
        </button>
       </span>
      ))}
    </div>
   );
  },
  [
   sources,
   edit,
   editing,
   headerStyle,
   buttonStyle,
   onHunkAction,
   onRevertFile,
   palette.removedCount,
   palette.addedCount,
  ],
 );

 useImperativeHandle(
  handleRef,
  () => ({
   scrollToFile(path: string) {
    // "smooth-auto" lets Pierre choose: a nearby file glides, a far one jumps.
    viewRef.current?.scrollTo({ type: "item", id: path, align: "start", behavior: "smooth-auto" });
   },
  }),
  [],
 );

 return (
  <View style={{ flex: 1, minHeight: 0 }}>
   {/*
    * Pierre takes this element as its scroll root: it reads `scrollTop` from it
    * and sets `overflow-anchor` on it, but it never gives it an overflow of its
    * own. Without `overflow-y: auto` here the virtualized content is laid out
    * at full height inside a clipped ancestor, and no wheel event can reach it.
    */}
   <EditProvider createEditor={createEditor}>
    <CodeView
     ref={viewRef}
     items={items}
     options={options}
     disableWorkerPool
     renderHeaderMetadata={renderHeaderMetadata}
     onItemEditComplete={onItemEditComplete}
     style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}
    />
   </EditProvider>
  </View>
 );
});
