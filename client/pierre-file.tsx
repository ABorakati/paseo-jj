import { CodeView, EditProvider, Editor } from "./vendor/pierre.js";
import type { CodeViewHandle, CodeViewItem, EditorFactory } from "./vendor/pierre.js";
import type { Ref } from "react";
import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { View } from "react-native";
import type { DiffPalette } from "./palette";

/** What the file tab asks of the view: the text as it stands in the editor. */
export interface PierreFileHandle {
 /** The editor's current text, or null before the editor has attached. */
 getText(): string | null;
}

interface SaveKeyEvent {
 key: string;
 ctrlKey: boolean;
 metaKey: boolean;
 altKey: boolean;
 preventDefault(): void;
}

interface KeyTarget {
 addEventListener(type: "keydown", listener: (event: SaveKeyEvent) => void): void;
 removeEventListener(type: "keydown", listener: (event: SaveKeyEvent) => void): void;
}

interface PierreFileViewProps {
 path: string;
 /** The text the editor starts from. It is read once: to show other text the
  *  tab remounts the view, because Pierre keeps an open session's draft across
  *  item updates and a save must not reset what is being typed. */
 text: string;
 /** True for the working copy: a file at any other revision is read-only. */
 editable: boolean;
 palette: DiffPalette;
 /** Called after each typed change with the editor's current text. */
 onChange(text: string): void;
 /** Ctrl/Cmd+S inside the editor. */
 onSave(): void;
 handleRef?: Ref<PierreFileHandle>;
}

/**
 * One whole file in Pierre's editor — the full-file counterpart of the diff.
 * The edit session stays open for as long as the file is editable, so the tab
 * reads like an editor rather than a viewer with an edit mode. Writing is the
 * tab's job: it takes the text through the handle, so the session never has to
 * end to be saved.
 */
export const PierreFileView = memo(function PierreFileView({
 path,
 text,
 editable,
 palette,
 onChange,
 onSave,
 handleRef,
}: PierreFileViewProps) {
 const viewRef = useRef<CodeViewHandle<undefined, undefined>>(null);
 const containerRef = useRef<HTMLDivElement | null>(null);

 const items = useMemo<CodeViewItem<undefined>[]>(
  () => [{ id: path, type: "file", file: { name: path, contents: text }, edit: editable }],
  // `text` is deliberately not a dependency: see the prop.
  [path, editable],
 );

 // The tab's own header names the file, so Pierre's would only repeat it.
 const options = useMemo(
  () => ({ theme: palette.isDark ? "pierre-dark" : "pierre-light", disableFileHeader: true }),
  [palette.isDark],
 );

 const createEditor = useCallback<EditorFactory<undefined, undefined>>(
  (type, editorOptions, editStateKey) => new Editor(type, editorOptions, editStateKey),
  [],
 );

 const readText = useCallback(() => viewRef.current?.getEditor(path)?.getText() ?? null, [path]);

 const onItemEditChange = useCallback(() => {
  const current = readText();
  if (current !== null) onChange(current);
 }, [onChange, readText]);

 // The tab writes through the handle, so a session that ends (the file closed
 // or turned read-only) has nothing left to install.
 const onItemEditComplete = useCallback(() => "reject" as const, []);

 useImperativeHandle(handleRef, () => ({ getText: readText }), [readText]);

 // Pierre owns the editor's keys; a save shortcut is caught on the way out of
 // its shadow root, before the browser opens its own save dialog.
 const saveRef = useRef(onSave);
 saveRef.current = onSave;
 useEffect(() => {
  // The plugin builds without the DOM library (see held-keys.ts), so the slice
  // of the element and the event this reads is typed here.
  const element = containerRef.current as unknown as KeyTarget | null;
  if (element === null) return;
  const onKeyDown = (event: SaveKeyEvent) => {
   if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveRef.current();
   }
  };
  element.addEventListener("keydown", onKeyDown);
  return () => element.removeEventListener("keydown", onKeyDown);
 }, []);

 return (
  <View style={{ flex: 1, minHeight: 0 }}>
   {/* Pierre scrolls this element and never sets its overflow itself. */}
   <EditProvider createEditor={createEditor}>
    <CodeView
     ref={viewRef}
     containerRef={containerRef}
     items={items}
     options={options}
     disableWorkerPool
     onItemEditChange={onItemEditChange}
     onItemEditComplete={onItemEditComplete}
     style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}
    />
   </EditProvider>
  </View>
 );
});
