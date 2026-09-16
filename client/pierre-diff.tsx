import { CodeView, type CodeViewHandle, type CodeViewItem } from "./vendor/pierre.js";
import type { CSSProperties, Ref } from "react";
import { memo, useCallback, useImperativeHandle, useMemo, useRef } from "react";
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

interface PierreDiffViewProps {
 files: JjFileDiff[];
 split: boolean;
 palette: DiffPalette;
 /** Omitted outside the working copy, where a revert has nothing to undo. */
 onRevertFile?: (path: string) => void;
 onHunkAction?: (input: HunkActionInput) => void;
 handleRef?: Ref<PierreDiffHandle>;
}

const NOTE_STYLE: CSSProperties = { fontSize: 11, opacity: 0.75 };

/**
 * The diff surface. Pierre owns rendering, layout and highlighting; this module
 * owns the two things the panel needs on top: which jj file a rendered item is,
 * and the per-hunk controls the squash-by-selection work hangs off.
 *
 * The controls hang on the file header rather than on a line: Pierre gives the
 * host that one strip and no built-in accept/reject widget, and a control per
 * hunk in the header names every hunk of the file without depending on where
 * the pointer happens to be.
 */
export const PierreDiffView = memo(function PierreDiffView({
 files,
 split,
 palette,
 onRevertFile,
 onHunkAction,
 handleRef,
}: PierreDiffViewProps) {
 const viewRef = useRef<CodeViewHandle<undefined, undefined>>(null);

 // The path is the item id, which is what the file tree rail scrolls to.
 const items = useMemo<CodeViewItem<undefined>[]>(
  () =>
   files.map((file) => ({
    id: file.path,
    type: "diff" as const,
    fileDiff: parseFile(file),
   })),
  [files],
 );

 const sources = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);

 const options = useMemo(
  () => ({
   diffStyle: split ? ("split" as const) : ("unified" as const),
   theme: palette.isDark ? "pierre-dark" : "pierre-light",
  }),
  [split, palette.isDark],
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

 const hunkRowStyle = useMemo<CSSProperties>(
  () => ({ display: "flex", gap: 2, alignItems: "center" }),
  [],
 );

 /**
  * The file header is the one strip Pierre leaves to the host, so it carries
  * what the diff cannot say for itself: a note for a file with no hunks, the
  * per-file revert, and one accept/reject pair per hunk.
  */
 const renderHeaderMetadata = useCallback(
  (item: CodeViewItem<undefined>) => {
   if (item.type !== "diff") return null;
   const file = item.fileDiff;
   const source = sources.get(file.name);
   const note = source === undefined ? null : noteFor(source);
   const canRevert = onRevertFile !== undefined && source !== undefined;
   if (note === null && !canRevert && onHunkAction === undefined) return null;

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
     {onHunkAction === undefined
      ? null
      : file.hunks.map((hunk, hunkIndex) => (
       <span key={hunk.hunkSpecs ?? hunkIndex} style={hunkRowStyle}>
        <span style={NOTE_STYLE}>hunk {hunkIndex + 1}</span>
        <button
         type="button"
         style={buttonStyle}
         title={`Accept hunk ${hunkIndex + 1}`}
         aria-label={`Accept hunk ${hunkIndex + 1} of ${file.name}`}
         onClick={() => onHunkAction({ file: file.name, hunkIndex, kind: "accept" })}
        >
         ✓
        </button>
        <button
         type="button"
         style={buttonStyle}
         title={`Reject hunk ${hunkIndex + 1}`}
         aria-label={`Reject hunk ${hunkIndex + 1} of ${file.name}`}
         onClick={() => onHunkAction({ file: file.name, hunkIndex, kind: "reject" })}
        >
         ✗
        </button>
       </span>
      ))}
    </div>
   );
  },
  [sources, headerStyle, buttonStyle, hunkRowStyle, onHunkAction, onRevertFile, palette.removedCount],
 );

 useImperativeHandle(
  handleRef,
  () => ({
   scrollToFile(path: string) {
    // "smooth-auto" lets Pierre choose: a nearby file glides, a far one jumps.
    // An animated scroll to a distant file is overtaken by the virtualizer
    // measuring the items it scrolls past, and lands short.
    viewRef.current?.scrollTo({ type: "item", id: path, align: "start", behavior: "smooth-auto" });
   },
  }),
  [],
 );

 return (
  <View style={{ flex: 1, minHeight: 0 }}>
   <CodeView
    ref={viewRef}
    items={items}
    options={options}
    disableWorkerPool
    renderHeaderMetadata={renderHeaderMetadata}
    style={{ flex: 1, minHeight: 0 }}
   />
  </View>
 );
});
