import { CodeView, EditProvider, Editor } from "./vendor/pierre.js";
import type {
 CodeViewHandle,
 CodeViewItem,
 DiffLineAnnotation,
 EditCompletionDecision,
 EditorFactory,
 FileDiffEditCompleteEvent,
 FileDiffMetadata,
 FileEditCompleteEvent,
} from "./vendor/pierre.js";
import type { CSSProperties, Ref } from "react";
import { memo, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import type { JjFileDiff } from "../shared/contracts";
import type { DiffPalette } from "./palette";
import { noteFor } from "./pierre-patch";
import { parseAddedFile, parseFile } from "./pierre-parse";

/**
 * One hunk to move out of the revision on screen and into its parent. `file` is
 * the path exactly as `JjFileDiff.path` carries it, and `hunkIndex` counts hunks
 * in the parsed diff, in the order jj emitted them — not a rendered row. Both
 * name the same hunk the server parses out of `jj diff`, so a caller can hand
 * the pair straight to a jj command.
 */
export interface HunkActionInput {
 file: string;
 hunkIndex: number;
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
 /** Says why an editor could not open, when reading the file failed. */
 refused(message: string): void;
}

interface PierreDiffViewProps {
 files: JjFileDiff[];
 split: boolean;
 palette: DiffPalette;
 /** Paths whose body is shown. Every other file renders as its header only, so
  *  a long change reads as a list first and opens one file at a time. */
 expanded: ReadonlySet<string>;
 onToggleExpanded(path: string): void;
 /** Omitted outside the working copy, where a revert has nothing to undo. */
 onRevertFile?: (path: string) => void;
 onHunkAction?: (input: HunkActionInput) => void;
 /** Omitted outside the working copy: the panel edits the files it can write. */
 edit?: FileEditAccess;
 handleRef?: Ref<PierreDiffHandle>;
}

/** What a hunk's annotation carries: which hunk its control moves. */
interface HunkNote {
 hunkIndex: number;
}

type EditEvent =
 | FileEditCompleteEvent<HunkNote, undefined>
 | FileDiffEditCompleteEvent<HunkNote, undefined>;

/** The note gives way to the buttons: it shrinks to an ellipsis on one line,
 *  so the header never wraps below the file name. */
const NOTE_STYLE: CSSProperties = {
 fontSize: 11,
 opacity: 0.75,
 minWidth: 0,
 overflow: "hidden",
 textOverflow: "ellipsis",
 whiteSpace: "nowrap",
};
const HUNK_CONTROL_STYLE: CSSProperties = {
 display: "flex",
 justifyContent: "flex-end",
 padding: "2px 12px",
};
/** Two clicks on one file within this window open its editor. */
const DOUBLE_CLICK_MS = 450;

/**
 * Each hunk's control sits under the hunk's last line, so the button is read
 * as belonging to the lines above it. A hunk ending in a removal has no new-side
 * line there, so its annotation is placed on the old side instead.
 */
function hunkAnnotations(file: JjFileDiff): DiffLineAnnotation<HunkNote>[] {
 const annotations: DiffLineAnnotation<HunkNote>[] = [];
 file.hunks.forEach((hunk, hunkIndex) => {
  const last = hunk.lines[hunk.lines.length - 1];
  if (last === undefined) return;
  if (last.kind === "remove" && last.oldLine !== null) {
   annotations.push({ side: "deletions", lineNumber: last.oldLine, metadata: { hunkIndex } });
  } else if (last.newLine !== null) {
   annotations.push({ side: "additions", lineNumber: last.newLine, metadata: { hunkIndex } });
  }
 });
 return annotations;
}

/**
 * CodeView redraws an item only when its version changes, so the version has to
 * move with everything the item shows. A refetch keeps an unchanged file's
 * object (react-query shares equal data), so object identity is the content
 * identity: a new object is a new serial, and an old one keeps its own.
 */
const contentSerials = new WeakMap<JjFileDiff, number>();
let nextSerial = 1;
function contentSerial(file: JjFileDiff): number {
 let serial = contentSerials.get(file);
 if (serial === undefined) {
  serial = nextSerial++;
  contentSerials.set(file, serial);
 }
 return serial;
}

/**
 * What cannot be edited, and the sentence that says so. A removed file has no
 * new side to type into, and a binary one has no text.
 */
function editBlocker(file: JjFileDiff): string | null {
 if (file.binary) return "Binary file — no text diff.";
 if (file.status === "removed") return "Deleted in this change — nothing to edit.";
 if (file.hunks.length === 0) return "No content changes.";
 return null;
}

/**
 * The diff surface. Pierre owns rendering, layout and highlighting; this module
 * owns what the panel needs on top: which jj file a rendered item is, the
 * per-hunk controls, which files are open, and the inline edit that writes back
 * through the panel. A double click on a line opens that file's editor.
 */
export const PierreDiffView = memo(function PierreDiffView({
 files,
 split,
 palette,
 expanded,
 onToggleExpanded,
 onRevertFile,
 onHunkAction,
 edit,
 handleRef,
}: PierreDiffViewProps) {
 const viewRef = useRef<CodeViewHandle<HunkNote, undefined>>(null);
 /** The file whose text is open in the editor, if any. */
 const [editing, setEditing] = useState<string | null>(null);
 /**
  * Bumped whenever an edit settles, so the item redraws from the file on disk
  * after a save or a refusal even when the diff text itself did not change.
  */
 const [epoch, setEpoch] = useState(0);
 /** The text each read returned, which is what a write is checked against. */
 const readText = useRef(new Map<string, string>());
 /** Whether the session that is ending asked to be written. */
 const saving = useRef(false);
 /** Each path's last drawn state and the version it was given. */
 const versions = useRef(new Map<string, { key: string; version: number }>());
 /** The previous line click, which a second click on the same file completes. */
 const lastClick = useRef<{ path: string; at: number } | null>(null);
 /** Where the double click that opened the editor landed, so the caret starts
  *  there once the editor attaches. Null for a line the new file does not have. */
 const caretLine = useRef<number | null>(null);
 /** Added files opened for editing, hydrated with their text. Pierre loads the
  *  file pair on its own only for a changed or renamed file. */
 const addedDiffs = useRef(new Map<string, FileDiffMetadata>());

 const items = useMemo<CodeViewItem<HunkNote>[]>(
  () =>
   files.map((file) => {
    const open = editing === file.path;
    // A single file has nothing to list, so it is shown open.
    const collapsed = !open && files.length > 1 && !expanded.has(file.path);
    // The version is a counter per path that moves whenever anything the item
    // shows moves: its content, its edit mode, whether it is open, or a
    // settled edit. CodeView keeps whatever it drew while the version stands.
    const key = `${contentSerial(file)}:${open}:${collapsed}:${epoch}:${onHunkAction !== undefined}`;
    const previous = versions.current.get(file.path);
    const version =
     previous === undefined ? 1 : previous.key === key ? previous.version : previous.version + 1;
    versions.current.set(file.path, { key, version });
    return {
     // The path is the item id, which is what the file tree rail scrolls to.
     id: file.path,
     type: "diff" as const,
     version,
     collapsed,
     edit: edit !== undefined && open && editBlocker(file) === null,
     // The hunk controls stand under their hunks; an open editor has no hunks.
     annotations: onHunkAction === undefined || open ? undefined : hunkAnnotations(file),
     fileDiff: (open ? addedDiffs.current.get(file.path) : undefined) ?? parseFile(file),
    };
   }),
  [files, edit, editing, epoch, expanded, onHunkAction],
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

 /**
  * A double click on a line opens that file's editor. Pierre reports single
  * clicks, so the second click on the same file within the window completes
  * the pair; a click on another file starts a new one.
  */
 const onLineClick = useCallback(
  (
   props: { lineNumber: number; annotationSide?: "deletions" | "additions" },
   context: { item: CodeViewItem<HunkNote> },
  ) => {
   const path = context.item.id;
   const now = Date.now();
   const previous = lastClick.current;
   const isDouble =
    previous !== null && previous.path === path && now - previous.at < DOUBLE_CLICK_MS;
   lastClick.current = isDouble ? null : { path, at: now };
   if (!isDouble || edit === undefined || editing === path) return;
   const source = sources.get(path);
   if (source === undefined || editBlocker(source) !== null) return;
   // The editor holds the new file, so a removed line has no place in it.
   caretLine.current = props.annotationSide === "deletions" ? null : props.lineNumber;
   saving.current = false;
   if (source.status !== "added") {
    setEditing(path);
    return;
   }
   // An added file's text is read before the editor opens, so Pierre gets a
   // diff it can edit instead of one it would wait on forever.
   const access = edit;
   void access
    .read(path)
    .then((sides) => {
     readText.current.set(path, sides.newText);
     addedDiffs.current.set(path, parseAddedFile(source, sides.newText));
     setEditing(path);
    })
    .catch((error: unknown) => {
     access.refused(error instanceof Error ? error.message : `Could not read ${path}.`);
    });
  },
  [edit, editing, sources],
 );

 /**
  * The editor attaches after its file loads, which is the first moment a caret
  * can be placed: without one, typing has nowhere to go until another click.
  */
 const editorOptions = useMemo(
  () => ({
   onAttach(editor: { focus(options?: { lineNumber?: number | "first-visible" }): void }) {
    const lineNumber = caretLine.current ?? "first-visible";
    caretLine.current = null;
    requestAnimationFrame(() => editor.focus({ lineNumber }));
   },
  }),
  [],
 );

 const options = useMemo(
  () => ({
   diffStyle: split ? ("split" as const) : ("unified" as const),
   theme: palette.isDark ? "pierre-dark" : "pierre-light",
   // The diff arrives as hunks, so the editor can only be opened once Pierre
   // has the file pair this hands it.
   loadDiffFiles: edit === undefined ? undefined : loadDiffFiles,
   onLineClick,
  }),
  [split, palette.isDark, edit, loadDiffFiles, onLineClick],
 );

 const createEditor = useCallback<EditorFactory<HunkNote, undefined>>(
  (type, editorOptions, editStateKey) => new Editor(type, editorOptions, editStateKey),
  [],
 );

 const finishEdit = useCallback(
  (path: string, contents: string | undefined) => {
   const wantsWrite = saving.current;
   saving.current = false;
   setEditing(null);
   addedDiffs.current.delete(path);
   if (!wantsWrite || edit === undefined || contents === undefined) return;
   void edit
    .write({ path, content: contents, expected: readText.current.get(path) ?? "" })
    .finally(() => setEpoch((value) => value + 1));
  },
  [edit],
 );

 const onItemEditComplete = useCallback(
  function completeItemEdit(event: EditEvent, item: CodeViewItem<HunkNote>): EditCompletionDecision {
   if (!("newFile" in event) || event.newFile === null) {
    // A file item, or a deleted file: there is no new text to write.
    setEditing(null);
    addedDiffs.current.clear();
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
   flexWrap: "nowrap",
   minWidth: 0,
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
   flexShrink: 0,
   whiteSpace: "nowrap",
  }),
  [palette.splitDivider, palette.contextRow, palette.filePathMuted],
 );

 /** The chevron that opens and closes a file, ahead of its name. */
 const renderHeaderPrefix = useCallback(
  (item: CodeViewItem<HunkNote>) => {
   if (files.length <= 1 || editing === item.id) return null;
   const open = expanded.has(item.id);
   return (
    <button
     type="button"
     style={{ ...buttonStyle, border: "none", background: "transparent", padding: "0 4px" }}
     aria-label={`${open ? "Collapse" : "Expand"} ${item.id}`}
     aria-expanded={open}
     onClick={() => onToggleExpanded(item.id)}
    >
     {open ? "▾" : "▸"}
    </button>
   );
  },
  [buttonStyle, editing, expanded, files.length, onToggleExpanded],
 );

 /**
  * The file header carries what the diff cannot say for itself: the per-file
  * revert, and Save/Cancel while the file's editor is open. Hunk controls sit
  * under their hunks instead, where they cannot pile up in one strip.
  */
 const renderHeaderMetadata = useCallback(
  (item: CodeViewItem<HunkNote>) => {
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
     {open ? (
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
     ) : canRevert ? (
      <button
       type="button"
       style={{ ...buttonStyle, color: palette.removedCount }}
       aria-label={`Discard changes to ${file.name}`}
       onClick={() => onRevertFile?.(file.name)}
      >
       Discard
      </button>
     ) : null}
    </div>
   );
  },
  [sources, edit, editing, headerStyle, buttonStyle, onRevertFile, palette.removedCount, palette.addedCount],
 );

 /** One control under each hunk: move that hunk into the parent revision. */
 const renderAnnotation = useCallback(
  (annotation: { metadata?: HunkNote }, item: CodeViewItem<HunkNote>) => {
   const hunkIndex = annotation.metadata?.hunkIndex;
   if (hunkIndex === undefined || onHunkAction === undefined) return null;
   return (
    <div style={HUNK_CONTROL_STYLE}>
     <button
      type="button"
      style={buttonStyle}
      title="Move the hunk above out of this revision and into its parent"
      aria-label={`Move hunk ${hunkIndex + 1} of ${item.id} to the parent revision`}
      onClick={() => onHunkAction({ file: item.id, hunkIndex })}
     >
      Move to parent
     </button>
    </div>
   );
  },
  [buttonStyle, onHunkAction],
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
     renderHeaderPrefix={renderHeaderPrefix}
     renderHeaderMetadata={renderHeaderMetadata}
     renderAnnotation={renderAnnotation}
     onItemEditComplete={onItemEditComplete}
     editorOptions={editorOptions}
     style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}
    />
   </EditProvider>
  </View>
 );
});
