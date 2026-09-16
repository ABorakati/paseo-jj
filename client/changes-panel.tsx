import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { PointerEvent, ViewStyle } from "react-native";
import { actionRpc, diffRpc, snapshotRpc } from "../shared/contracts";
import { monoFont } from "./diff-view";
import { buildFileTree, orderFiles } from "./file-tree";
import { FileTreeRail } from "./file-tree-rail";
import {
 DROP_LABELS,
 actionTargets,
 bulkRevsets,
 clickedSelection,
 dropCall,
 dropGesture,
 type BulkVerb,
 type HeldModifiers,
} from "./gestures";
import { GraphView } from "./graph-view";
import { useHeldKeys } from "./held-keys";
import { buildPalette } from "./palette";
import { PierreDiffView, type HunkActionInput, type PierreDiffHandle } from "./pierre-diff";
import {
 SIDEBAR_INITIAL_WIDTH,
 SPLIT_INITIAL,
 draggedSidebarWidth,
 draggedSplitRatio,
} from "./panel-layout";
import { BranchBar } from "./branch-bar";
import { buildRevisionOptions, RevisionPickerOverlay, RevisionTrigger } from "./revision-picker";
import { RevisionActionsOverlay, type RevisionAction, type RevisionActionId } from "./revision-actions";
import { useSquashHunks } from "./squash";

/**
 * The working copy changes under the panel as agents edit files, so the
 * snapshot and diff are polled. jj snapshots incrementally, which keeps the
 * repeat cost well below the first read of a repository.
 */
const POLL_MS = 5000;

/** The picker is reused for the branch actions: the title and what a pick means
 *  change, the searchable list does not. */
type RevisionPickerPurpose = "select" | "merge" | "rebase" | "squash" | "squash-files";

const PICKER_TITLE: Record<RevisionPickerPurpose, string> = {
 select: "Choose a revision",
 merge: "Merge with…",
 rebase: "Rebase branch onto…",
 squash: "Squash into…",
 "squash-files": "Move the selected files into…",
};

/** react-native's ViewStyle has neither key, and both matter on a desktop host:
 *  a handle with no cursor reads as a plain border, and one that lets the
 *  browser start a text selection loses the gesture to a native drag. Applied
 *  on the web host only, so a native build never sees the unknown keys. */
const WIDTH_HANDLE = { cursor: "col-resize", userSelect: "none" } as unknown as ViewStyle;
const HEIGHT_HANDLE = { cursor: "row-resize", userSelect: "none" } as unknown as ViewStyle;

/** The history verbs, in the order they are reached for. A verb that can leave
 *  a revision behind carries the question its confirmation asks, because the
 *  row itself cannot show what will be left. */
const REVISION_ACTIONS: RevisionAction[] = [
 { id: "edit", label: "Edit", hint: "move the working copy to this revision" },
 { id: "new", label: "New child", hint: "start a revision on top of this one" },
 { id: "insert-before", label: "Insert before", hint: "start a revision between this and its parent" },
 { id: "insert-after", label: "Insert after", hint: "start a revision between this and its children" },
 { id: "duplicate", label: "Duplicate", hint: "copy this revision onto its parents" },
 { id: "merge", label: "Merge with…", hint: "a new revision with two parents" },
 { id: "rebase", label: "Rebase onto…", hint: "move this branch onto another revision" },
 {
  id: "squash",
  label: "Squash into parent",
  hint: "fold this revision's changes into the one below",
  confirm: "Squash this revision into its parent? It is abandoned if it empties.",
 },
 {
  id: "squash-into",
  label: "Squash into…",
  hint: "fold this revision's changes into another one",
 },
 {
  id: "absorb",
  label: "Absorb",
  hint: "move each change to the ancestor that last touched those lines",
  confirm: "Absorb this revision into its mutable ancestors?",
 },
 { id: "bookmark-advance", label: "Advance bookmark", hint: "move a bookmark forward to this revision" },
 { id: "push", label: "Push bookmark", hint: "publish the named bookmark to its remote" },
 { id: "push-tracked", label: "Push tracked", hint: "publish every tracked bookmark" },
 {
  id: "abandon",
  label: "Abandon",
  hint: "drop this revision and its descendants",
  confirm: "Abandon this revision? Its descendants move to its parents.",
 },
];

/** The verbs a set of rows can run. jj takes the whole selection in one command
 *  for abandon and rebase; a squash goes one revision at a time, which is why
 *  the confirm question says so. */
const bulkVerbActions = (count: number): RevisionAction[] => [
 {
  id: "abandon",
  label: `Abandon ${count} revisions`,
  hint: "drop every one of them, and their descendants",
  confirm: `Abandon ${count} revisions? Their descendants move to their parents.`,
 },
 {
  id: "squash",
  label: "Squash into parent",
  hint: "fold each one into the revision below it",
  confirm: `Squash ${count} revisions into their parents, one command each? One that empties out is abandoned.`,
 },
 { id: "rebase", label: "Rebase onto…", hint: "move the selected branches onto another revision" },
];

/** How the panel names each bulk verb in the report it shows afterwards. */
const BULK_VERB_LABELS: Record<BulkVerb, string> = {
 abandon: "Abandon",
 squash: "Squash into parent",
 rebase: "Rebase onto",
};

/** A drag has to be a drag: below this the press is the click that selects the
 *  row, and swallowing it would leave the diff unable to follow the graph. */
const DRAG_THRESHOLD = 4;

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

/**
 * The pointer reports where it is in viewport coordinates, so the drag HUD is
 * pinned the same way; the panel's own box would offset it, and on a native host
 * `fixed` is not a position that exists, which is why the stylesheet carries an
 * `absolute` fallback under it.
 */
const DRAG_HUD_FIXED = { position: "fixed" } as unknown as ViewStyle;

/** The live drag, in the closure that ends it: the row picked up, the row the
 *  pointer is over, and whether it has moved far enough to be a drag at all. */
interface DragControl {
 changeId: string;
 bookmark: string | null;
 startX: number;
 startY: number;
 active: boolean;
 targetId: string | null;
}

/** The part of a live drag the panel draws from. */
interface DragVisual {
 draggedId: string;
 targetId: string | null;
 bookmark: string | null;
 x: number;
 y: number;
}

export function ChangesPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
 const workspace = useWorkspace(workspaceId, (snapshot) => ({
  directory: snapshot.directory,
  name: snapshot.name,
 }));
 const directory = workspace?.directory ?? null;

 const callSnapshot = useRpc(snapshotRpc);
 const callDiff = useRpc(diffRpc);
 const callAction = useRpc(actionRpc);
 const toast = useToast();
 const queryClient = useQueryClient();
 const diffRef = useRef<PierreDiffHandle>(null);

 const [revset, setRevset] = useState("@");
 // Unified reads top to bottom and needs no horizontal room, which is what this
 // pane usually has. Split stays a click away on a wide layout.
 const [split, setSplit] = useState(false);
 const [message, setMessage] = useState("");
 const [pendingRevert, setPendingRevert] = useState<string | null>(null);
 const [picker, setPicker] = useState<RevisionPickerPurpose | null>(null);
 /** The revisions a pick from the picker acts on when the picker was opened
  *  from a bulk verb: it cannot carry a list, and Escape may empty the
  *  selection while it is up, which must not quietly narrow the verb. */
 const [pickerTargets, setPickerTargets] = useState<string[] | null>(null);
 const [bookmarkName, setBookmarkName] = useState("");
 const [pendingBookmarkDelete, setPendingBookmarkDelete] = useState<string | null>(null);
 const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set());
 const [treeVisible, setTreeVisible] = useState(!layout.compact);
 const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_INITIAL_WIDTH);
 const [filesMinimized, setFilesMinimized] = useState(false);
 const [revisionsMinimized, setRevisionsMinimized] = useState(false);
 const [splitRatio, setSplitRatio] = useState(SPLIT_INITIAL);
 const [selectedPath, setSelectedPath] = useState<string | null>(null);
 /** Paths picked in the tree, for a move into another revision. */
 const [checkedPaths, setCheckedPaths] = useState<ReadonlySet<string>>(new Set());
 const [actionsOpen, setActionsOpen] = useState(false);
 /** The rows gathered with ctrl/cmd-click, which the bulk verbs act on. */
 const [selection, setSelection] = useState<ReadonlySet<string>>(EMPTY_SELECTION);
 /** The live drag as the panel draws it: which row is picked up, which row the
  *  pointer is over, and where the pointer is, for the HUD. */
 const [drag, setDrag] = useState<DragVisual | null>(null);
 /** The same drag where it is ended from. It carries the press's starting
  *  point, so a move that has not passed the drag threshold changes nothing on
  *  screen: a click that nudges the pointer by a pixel is still a click. */
 const dragRef = useRef<DragControl | null>(null);
 /** A press that arrives just after a drop is that drag's tail, not a click on
  *  the row it happened to land on. */
 const suppressSelect = useRef(false);

 /** Escape is the reader's way out of a selection, so it is the keyboard's only
  *  job here; the panel clears the set and leaves the diff's revision alone. */
 const clearSelection = useCallback(() => setSelection(EMPTY_SELECTION), []);

 /**
  * The modifier keys held right now. They come from the keyboard rather than
  * from the pointer because react-native's `PointerEvent` carries no
  * `ctrlKey`/`shiftKey`/`metaKey`, and only a browser has the window to read
  * them from: on any other host the panel holds no modifiers, so a drag falls
  * back to the action its no-modifier case names.
  */
 const held = useHeldKeys(layout.platform === "web", clearSelection);

 /** A drag is measured against the size at the moment the press happened. */
 const sidebarWidthRef = useRef(sidebarWidth);
 const splitRatioRef = useRef(splitRatio);
 const sidebarHeightRef = useRef(0);
 /** Live drags; null when nothing is being dragged. */
 const sidebarDrag = useRef<{ startX: number; startWidth: number } | null>(null);
 const splitDrag = useRef<{ startY: number; startRatio: number } | null>(null);

 useEffect(() => {
  sidebarWidthRef.current = sidebarWidth;
  splitRatioRef.current = splitRatio;
 }, [sidebarWidth, splitRatio]);

 /**
  * The drag is tracked on the pane that contains the handle rather than on the
  * handle itself. Pointer events bubble, so a move anywhere in the pane reaches
  * these handlers — which matters because the handle shifts under the cursor as
  * the sidebar resizes, and a gesture tied to a 6px strip cannot follow it.
  *
  * A dragged revision row rides the same handler: the rows live in a scrolling
  * list and the pointer leaves them as soon as it moves on, so the pane is what
  * keeps reporting where the pointer is.
  */
 const onDragMove = (event: PointerEvent) => {
  const { pageX, pageY } = event.nativeEvent;
  const revision = dragRef.current;
  if (revision) {
   if (!revision.active) {
    const moved =
     Math.abs(pageX - revision.startX) >= DRAG_THRESHOLD ||
     Math.abs(pageY - revision.startY) >= DRAG_THRESHOLD;
    if (!moved) return;
    revision.active = true;
    setDrag({
     draggedId: revision.changeId,
     targetId: revision.targetId,
     bookmark: revision.bookmark,
     x: pageX,
     y: pageY,
    });
    return;
   }
   setDrag((current) => (current ? { ...current, x: pageX, y: pageY } : current));
   return;
  }

  const sidebar = sidebarDrag.current;
  if (sidebar) {
   const deltaX = pageX - sidebar.startX;
   if (Math.abs(deltaX) >= 2) {
    setSidebarWidth(draggedSidebarWidth(sidebar.startWidth, deltaX));
   }
   return;
  }
  const split = splitDrag.current;
  if (split) {
   const deltaY = pageY - split.startY;
   if (Math.abs(deltaY) >= 2) {
    setSplitRatio(draggedSplitRatio(split.startRatio, deltaY, sidebarHeightRef.current));
   }
  }
 };

 const endDrag = () => {
  sidebarDrag.current = null;
  splitDrag.current = null;
  const revision = dragRef.current;
  dragRef.current = null;
  if (!revision) return;
  setDrag(null);
  // Below the threshold nothing was dragged, so the press stays the click the
  // row's own handler turns into a selection.
  if (!revision.active) return;
  suppressSelect.current = true;
  const target = revision.targetId;
  if (target === null || target === revision.changeId) return;
  if (revision.bookmark !== null) {
   // A bookmark pill dropped on a row is the one drop that moves a name rather
   // than history, so it takes the same verb the bookmark field does.
   runAction.mutate({
    directory: directory ?? "",
    action: "bookmark-set",
    name: revision.bookmark,
    revset: target,
   });
   return;
  }
  runAction.mutate({
   directory: directory ?? "",
   ...dropCall(dropGesture(held), revision.changeId, target),
  });
 };

 /** A press that may become a drag: the row it started on, the bookmark when it
  *  started on a pill, and where the pointer was. */
 const startDrag = useCallback(
  (changeId: string, bookmark: string | null, pageX: number, pageY: number) => {
   // A press on a bookmark pill reaches the pill first and the row second, and
   // the panel must keep the narrower of the two: a pill being dragged moves the
   // bookmark, so the row it sits on must not take the gesture over. A press on
   // another row is a new gesture and replaces the stale one.
   const current = dragRef.current;
   if (
    current !== null &&
    current.changeId === changeId &&
    current.bookmark !== null &&
    bookmark === null
   ) {
    return;
   }
   dragRef.current = { changeId, bookmark, startX: pageX, startY: pageY, active: false, targetId: null };
   suppressSelect.current = false;
  },
  [],
 );

 /** The pointer is over a row while a drag is live: it is where the drop lands. */
 const onDragOver = useCallback((changeId: string) => {
  const revision = dragRef.current;
  if (revision === null || !revision.active || revision.targetId === changeId) return;
  revision.targetId = changeId;
  setDrag((current) => (current === null ? current : { ...current, targetId: changeId }));
 }, []);
 const palette = useMemo(() => buildPalette(theme), [theme]);
 const metrics = useMemo(
  () => ({ fontSize: layout.compact ? 11 : 12, fontFamily: monoFont(layout.platform) }),
  [layout.compact, layout.platform],
 );

 const snapshotQuery = useQuery({
  queryKey: ["jj", "snapshot", directory],
  queryFn: () => callSnapshot({ directory: directory ?? "" }),
  enabled: directory !== null,
  refetchInterval: POLL_MS,
 });

 const isRepo = snapshotQuery.data?.isRepo === true;
 const diffQuery = useQuery({
  queryKey: ["jj", "diff", directory, revset],
  queryFn: () => callDiff({ directory: directory ?? "", revset }),
  enabled: directory !== null && isRepo,
  refetchInterval: POLL_MS,
 });

 const runAction = useMutation({
  mutationFn: callAction,
  onSuccess: async (result) => {
   if (!result.ok) {
    toast.error(result.error ?? "jj command failed.");
    return;
   }
   toast.show(result.output || "Done", { variant: "success" });
   setMessage("");
   setPendingRevert(null);
   await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["jj", "snapshot"] }),
    queryClient.invalidateQueries({ queryKey: ["jj", "diff"] }),
   ]);
  },
  onError: (error: unknown) => {
   toast.error(error instanceof Error ? error.message : "The daemon call failed.");
  },
 });

 /**
  * A bulk verb is one daemon call per command in its plan. The calls run in
  * order rather than together: a squash of three rows folds the second one into
  * the tree the first one left, and when one of them fails the report has to say
  * which revision it was.
  */
 const bulkAction = useMutation({
  mutationFn: async (variables: {
   verb: BulkVerb;
   count: number;
   calls: Array<RpcInput<typeof actionRpc>>;
  }) => {
   const results: Array<RpcOutput<typeof actionRpc>> = [];
   for (const call of variables.calls) results.push(await callAction(call));
   return results;
  },
  onSuccess: async (results, variables) => {
   const failures = results.filter((result) => !result.ok);
   const done = results.length - failures.length;
   if (done > 0) {
    toast.show(`${BULK_VERB_LABELS[variables.verb]}: ${done} of ${variables.count} done`, {
     variant: "success",
    });
   }
   for (const failure of failures) toast.error(failure.error ?? "jj command failed.");
   // The rows have just been rewritten: one may be gone and another may have
   // emptied out, so leaving them selected would aim the next verb at revisions
   // that are no longer the ones the reader picked.
   setSelection(EMPTY_SELECTION);
   await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["jj", "snapshot"] }),
    queryClient.invalidateQueries({ queryKey: ["jj", "diff"] }),
   ]);
  },
  onError: (error: unknown) => {
   toast.error(error instanceof Error ? error.message : "The daemon call failed.");
  },
 });

 const snapshot = snapshotQuery.data;
 const files = useMemo(() => diffQuery.data?.files ?? [], [diffQuery.data]);
 // The tree is the ordering authority for both surfaces: the rail lists files
 // in this sequence and the diff renders it, so a row can never scroll to a
 // file that sits somewhere else in the list.
 const orderedFiles = useMemo(() => orderFiles(files), [files]);
 /** The pick only ever names files of the revision on screen, so a path left
  *  over from another revision falls out of the selection on its own. */
 const checkedFiles = useMemo(
  () => new Set(orderedFiles.map((file) => file.path).filter((path) => checkedPaths.has(path))),
  [orderedFiles, checkedPaths],
 );
 const allFilesChecked =
  orderedFiles.length > 0 && orderedFiles.every((file) => checkedPaths.has(file.path));
 const fileTree = useMemo(() => buildFileTree(files, collapsedFolders), [files, collapsedFolders]);
 const revisionOptions = useMemo(
  () =>
   buildRevisionOptions({
    current: snapshot?.current ?? null,
    parent: snapshot?.parent ?? null,
    recent: snapshot?.recent ?? [],
    bookmarks: snapshot?.bookmarks ?? [],
    graph: snapshot?.graph ?? [],
   }),
  [snapshot],
 );
 const revisionName =
  (revisionOptions.find((option) => option.id === revset)?.label ||
   // A revision picked out of the graph is a change id, which is not one of the
   // picker's presets; its own description names it better than the id does.
   snapshot?.graph.find((change) => change.changeId === revset)?.description.trim()) ||
  revset;
 // The graph marks a revision by change id, while the panel tracks a revset, so
 // the two presets are resolved to the revision they currently name.
 const selectedChangeId =
  revset === "@"
   ? (snapshot?.current?.changeId ?? null)
   : revset === "@-"
    ? (snapshot?.parent?.changeId ?? null)
    : revset;
 /** The revisions the next verb acts on: the rows gathered with ctrl-click, or
  *  the one the diff is reading when nothing is gathered. More than one is what
  *  turns the actions list into the bulk one. */
 const targets = useMemo(
  () => actionTargets(selection, selectedChangeId),
  [selection, selectedChangeId],
 );
 const bulk = targets.length > 1;
 const allCollapsed =
  fileTree.folderPaths.length > 0 &&
  fileTree.folderPaths.every((path) => collapsedFolders.has(path));
 /** Whichever section is open on its own takes the whole column; with both open
  *  they share it by the divider's ratio. */
 const filesFlex = filesMinimized ? 0 : revisionsMinimized ? 1 : splitRatio;
 const revisionsFlex = revisionsMinimized ? 0 : filesMinimized ? 1 : 1 - splitRatio;
 const actions = useMemo<RevisionAction[]>(() => {
  const name = bookmarkName.trim();
  if (name) return REVISION_ACTIONS;
  // With no name in the field there is nothing to publish by name, so the push
  // row that would silently fall back to the tracked set is left out.
  return REVISION_ACTIONS.filter((action) => action.id !== "push");
 }, [bookmarkName]);
 /** What the overlay lists: the verbs for a whole selection once more than one
  *  row is gathered, the one revision's verbs otherwise. */
 const overlayActions = useMemo(
  () => (bulk ? bulkVerbActions(targets.length) : actions),
  [actions, bulk, targets.length],
 );

 const resizeCursor = layout.platform === "web" ? WIDTH_HANDLE : undefined;
 const splitCursor = layout.platform === "web" ? HEIGHT_HANDLE : undefined;
 /** Bookmarks already on the selected revision, offered as names to reuse. */
 const selectedBookmarks =
  snapshot?.graph.find((change) => change.changeId === selectedChangeId)?.bookmarks ?? [];

 const styles = useMemo(
  () => ({
   screen: { flex: 1, backgroundColor: theme.colors.surface0 },
   header: { paddingHorizontal: layout.compact ? 12 : 16, paddingTop: 12, paddingBottom: 6, gap: 6 },
   row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
   changeId: { color: palette.filePathMuted, fontSize: metrics.fontSize, fontFamily: metrics.fontFamily },
   description: {
    color: palette.filePath,
    fontSize: layout.compact ? 15 : 16,
    fontWeight: "600" as const,
   },
   muted: { color: palette.filePathMuted, fontSize: metrics.fontSize },
   chip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: palette.splitDivider,
   },
   chipActive: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
   chipText: { fontSize: metrics.fontSize, color: palette.filePathMuted },
   chipTextActive: { color: theme.colors.accentForeground, fontSize: metrics.fontSize },
   toolbar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    paddingHorizontal: layout.compact ? 12 : 16,
    paddingBottom: 8,
    flexWrap: "wrap" as const,
   },
   button: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: palette.splitDivider,
   },
   buttonPrimary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
   buttonText: { color: palette.filePath, fontSize: metrics.fontSize },
   buttonTextPrimary: { color: theme.colors.accentForeground, fontSize: metrics.fontSize },
   disabled: { opacity: 0.45 },
   buttonActive: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
   buttonTextActive: { color: theme.colors.accentForeground, fontSize: metrics.fontSize },
   body: { flex: 1, flexDirection: "row" as const, minHeight: 0 },
   /** The sidebar's width comes from state; the handle beside it paints the
    *  edge, so the rail carries no border of its own. */
   rail: { flexShrink: 0 },
   railWide: { flex: 1 },
   /** Grab area for the sidebar's width: a 6px strip that paints a single line,
    *  so the edge still looks like a border. */
   sidebarHandle: {
    width: 6,
    flexShrink: 0,
    alignItems: "center" as const,
    justifyContent: "center" as const,
   },
   sidebarHandleLine: { width: 1, flex: 1, backgroundColor: palette.splitDivider },
   /** Grab area between the two sections, shown only while both are open. */
   splitHandle: { height: 7, justifyContent: "center" as const },
   splitHandleLine: { height: 1, backgroundColor: palette.splitDivider },
   railDivider: { height: 1, backgroundColor: palette.splitDivider },
   composer: {
    borderTopWidth: 1,
    borderColor: palette.splitDivider,
    padding: layout.compact ? 10 : 12,
    gap: 8,
    backgroundColor: theme.colors.surface1,
   },
   input: {
    color: palette.filePath,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: palette.splitDivider,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: metrics.fontSize + 1,
   },
   center: {
    flex: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    padding: 24,
    gap: 8,
   },
   banner: {
    marginHorizontal: layout.compact ? 12 : 16,
    marginBottom: 8,
    padding: 10,
    borderRadius: 8,
    backgroundColor: theme.colors.surface1,
    borderLeftWidth: 3,
    borderLeftColor: palette.conflict,
    gap: 4,
   },
   confirmBar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    padding: 10,
    backgroundColor: theme.colors.surface1,
    borderTopWidth: 1,
    borderColor: palette.splitDivider,
   },
   /** The drag HUD. It follows the pointer in viewport coordinates, which only
    *  the web host can express, so this is the fallback position and the web
    *  one is layered over it at the render site. */
   dragHud: {
    position: "absolute" as const,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.accent,
   },
   dragHudText: { color: palette.filePath, fontSize: metrics.fontSize },
  }),
  [palette, theme, metrics, layout.compact],
 );

 /**
  * The file tree is the ordering authority for both surfaces, so a picked path
  * is already the id Pierre keys that file's rendered item by.
  */
 const scrollToFile = useCallback((path: string) => {
  diffRef.current?.scrollToFile(path);
 }, []);

 /**
  * The hunk buttons in a file header move one hunk out of the revision on
  * screen and into that revision's parent: their "reject" means the change
  * leaves this revision. "Accept" keeps it here, which is what jj does when
  * asked for nothing. The destination is written as the displayed revset's own
  * parent so the hunk numbering the server checks against is the one on screen.
  */
 const squashHunks = useSquashHunks(workspaceId);
 const onHunkAction = useCallback(
  (input: HunkActionInput) => {
   if (input.kind === "accept") {
    toast.show(`Hunk ${input.hunkIndex + 1} stays in this revision`);
    return;
   }
   squashHunks({
    file: input.file,
    hunkIndexes: [input.hunkIndex],
    from: revset,
    into: `(${revset})-`,
   }).catch((error: unknown) => {
    // jj's own words: it refuses an immutable destination and hunks that no
    // longer match with a message the reader can act on.
    toast.show(error instanceof Error ? error.message : "jj refused to move that hunk");
   });
  },
  [revset, squashHunks, toast],
 );

 const selectFile = useCallback(
  (path: string) => {
   setSelectedPath(path);
   scrollToFile(path);
   // On a narrow pane the tree replaces the diff, so a picked file is done and
   // the reader wants the diff back.
   if (layout.compact) setTreeVisible(false);
  },
  [layout.compact, scrollToFile],
 );

 /** The sidebar selects the revision the diff reads; on a narrow pane that is
  *  the whole errand, so it hands the pane back to the diff. Ctrl/cmd-click adds
  *  the row to the selection instead of moving the diff to it. */
 const selectRevision = useCallback(
  (changeId: string) => {
   // The press that ends a drag lands on a row as well. It is the tail of a
   // gesture that has already run its verb, not a request to read that revision.
   if (suppressSelect.current) return;
   setRevset(changeId);
   setSelectedPath(null);
   setSelection((current) => clickedSelection(current, changeId, held.additive));
   if (layout.compact) setTreeVisible(false);
  },
  [held.additive, layout.compact],
 );

 const toggleFolder = useCallback((path: string) => {
  setCollapsedFolders((folders) => {
   const next = new Set(folders);
   if (next.has(path)) next.delete(path);
   else next.add(path);
   return next;
  });
 }, []);

 const toggleCollapseAll = useCallback(() => {
  setCollapsedFolders((folders) => {
   const allClosed =
    fileTree.folderPaths.length > 0 && fileTree.folderPaths.every((path) => folders.has(path));
   return allClosed ? new Set<string>() : new Set(fileTree.folderPaths);
  });
 }, [fileTree.folderPaths]);

 const toggleChecked = useCallback((path: string) => {
  setCheckedPaths((current) => {
   const next = new Set(current);
   if (next.has(path)) next.delete(path);
   else next.add(path);
   return next;
  });
 }, []);

 const toggleCheckAll = useCallback(() => {
  setCheckedPaths(
   allFilesChecked ? new Set() : new Set(orderedFiles.map((file) => file.path)),
  );
 }, [allFilesChecked, orderedFiles]);

 /** Picked files still need somewhere to go, which is what the picker answers. */
 const askWhereCheckedGo = useCallback(() => {
  if (checkedFiles.size > 0) setPicker("squash-files");
 }, [checkedFiles]);

 /**
  * Runs a bulk verb over the revisions the reader gathered. The plan says how
  * many commands that is — one for abandon and rebase, one per revision for a
  * squash — and the calls go in the order the rows were picked.
  */
 const runBulk = useCallback(
  (verb: BulkVerb, revs: string[], destination?: string) => {
   const revsets = bulkRevsets(verb, revs);
   if (revsets.length === 0) return;
   setActionsOpen(false);
   bulkAction.mutate({
    verb,
    count: revs.length,
    calls: revsets.map((revset) => ({
     directory: directory ?? "",
     action: verb,
     revset,
     target: destination,
    })),
   });
  },
  [bulkAction, directory],
 );

 /** A pick means whatever the picker was opened for: a revision to read, a
 /** A pick means whatever the picker was opened for: a revision to read, a
  *  second parent to merge, a destination to rebase onto, the revision the
  *  picked files move into, or — when it was opened from a bulk verb — the
  *  destination for a whole selection. */
 const pickRevision = useCallback(
  (id: string) => {
   const purpose = picker;
   setPicker(null);
   if (purpose === "squash-files") {
    runAction.mutate(
     {
      directory: directory ?? "",
      action: "squash",
      revset: selectedChangeId ?? undefined,
      target: id,
      paths: [...checkedFiles],
     },
     // The pick is only spent once jj took it: a destination it refuses leaves
     // the selection standing, ready for another try.
     {
      onSuccess: (result) => {
       if (result.ok) setCheckedPaths(new Set());
      },
     },
    );
    return;
   }
   if (purpose === "merge" || purpose === "rebase" || purpose === "squash") {
    // The picker can only carry one value, so the selection it was opened for
    // waits here; a pick arriving without one is the single-revision verb.
    const revs = pickerTargets;
    setPickerTargets(null);
    if (revs !== null) {
     runBulk("rebase", revs, id);
     return;
    }
    runAction.mutate({
     directory: directory ?? "",
     action: purpose,
     revset: selectedChangeId ?? undefined,
     target: id,
    });
    return;
   }
   setRevset(id);
   setSelectedPath(null);
  },
  [checkedFiles, directory, picker, pickerTargets, runAction, runBulk, selectedChangeId],
 );

 const setBookmark = useCallback(() => {
  const name = bookmarkName.trim();
  if (!name) return;
  runAction.mutate({
   directory: directory ?? "",
   action: "bookmark-set",
   name,
   revset: selectedChangeId ?? undefined,
  });
 }, [bookmarkName, directory, runAction, selectedChangeId]);

 const deleteBookmark = useCallback(() => {
  const name = bookmarkName.trim();
  // Deleting a bookmark is published on the next push, so it is confirmed.
  if (name) setPendingBookmarkDelete(name);
 }, [bookmarkName]);

 const confirmBookmarkDelete = useCallback(() => {
  const name = pendingBookmarkDelete;
  if (!name) return;
  runAction.mutate({ directory: directory ?? "", action: "bookmark-delete", name });
 }, [directory, pendingBookmarkDelete, runAction]);

 /** Runs one verb from the actions list. The two that need a second revision
  *  hand off to the picker instead of guessing one. */
 const runRevisionAction = useCallback(
  (id: RevisionActionId) => {
   const revset = selectedChangeId ?? undefined;
   const target = directory ?? "";
   const name = bookmarkName.trim();
   if (id === "squash-into") {
    setActionsOpen(false);
    setPicker("squash");
    return;
   }
   if (id === "merge" || id === "rebase") {
    setActionsOpen(false);
    setPicker(id);
    return;
   }
   setActionsOpen(false);
   switch (id) {
    case "push":
     runAction.mutate({ directory: target, action: "push", name: name || undefined });
     return;
    case "push-tracked":
     runAction.mutate({ directory: target, action: "push" });
     return;
    case "bookmark-advance":
     runAction.mutate({ directory: target, action: "bookmark-advance", name: name || undefined, revset });
     return;
    case "insert-before":
    case "insert-after":
     // The composer's text names the revision being inserted, when it is set.
     runAction.mutate({ directory: target, action: id, revset, message: message.trim() || undefined });
     return;
    default:
     runAction.mutate({ directory: target, action: id, revset });
   }
  },
  [bookmarkName, directory, message, runAction, selectedChangeId],
 );

 /** Runs one verb from the bulk list. The two that act where they are go at
   *  once; a rebase needs a destination, so it hands the selection to the
   *  picker and comes back when there is one. */
 const runBulkAction = useCallback(
  (id: RevisionActionId) => {
   if (id === "rebase") {
    setPickerTargets(targets);
    setPicker("rebase");
    return;
   }
   if (id === "abandon" || id === "squash") runBulk(id, targets);
  },
  [runBulk, targets],
 );


 if (directory === null) {
  return (
   <View style={styles.center}>
    <Text style={styles.muted}>This workspace has no directory yet.</Text>
   </View>
  );
 }

 if (snapshotQuery.isPending) {
  return (
   <View style={styles.center}>
    <Text style={styles.muted}>Reading the jj workspace…</Text>
   </View>
  );
 }

 if (snapshotQuery.isError) {
  return (
   <View style={styles.center}>
    <Text style={styles.description}>Could not reach the daemon</Text>
    <Text style={styles.muted}>{(snapshotQuery.error as Error).message}</Text>
   </View>
  );
 }

 if (snapshot?.jjAvailable === false) {
  return (
   <View style={styles.center}>
    <Text style={styles.description}>Jujutsu is not installed</Text>
    <Text style={styles.muted}>
     The daemon found no `jj` executable on its PATH, so it cannot read this workspace.
    </Text>
   </View>
  );
 }

 if (!snapshot?.isRepo) {
  return (
   <View style={styles.center}>
    <Text style={styles.description}>Not a Jujutsu workspace</Text>
    <Text style={styles.muted}>{directory}</Text>
    <Text style={styles.muted}>
     Run `jj git init --colocate` here to track this directory with jj.
    </Text>
   </View>
  );
 }

 const current = snapshot.current;
 const isEmpty = current?.empty ?? true;
 const canCommit = !runAction.isPending && message.trim().length > 0;
 const busy = runAction.isPending || bulkAction.isPending;
 /** The HUD's words: the verb the held keys chose, and what it would act on.
  *  The target is still unknown until the pointer is over a row, which is what
  *  the ellipsis says. */
 const dragLabel =
  drag === null
   ? ""
   : drag.bookmark === null
    ? DROP_LABELS[dropGesture(held)]
    : `Move bookmark ${drag.bookmark} to`;

 return (
  <View style={styles.screen}>
   <View style={styles.header}>
    <View style={styles.row}>
     <Pressable
      accessibilityRole="button"
      accessibilityLabel="Copy the change id"
      onPress={() => {
       const id = current?.changeId;
       if (!id) return;
       void copyText(id)
        .then(() => toast.show(`Copied ${id}`, { variant: "success" }))
        .catch(() => toast.error("Could not copy the change id."));
      }}
     >
      <Text style={styles.changeId}>{current?.changeId.slice(0, 8) ?? "--------"}</Text>
     </Pressable>
     {current?.conflicted ? (
      <View style={[styles.chip, { borderColor: palette.conflict }]}>
       <Text style={[styles.chipText, { color: palette.conflict }]}>conflicted</Text>
      </View>
     ) : null}
     {isEmpty ? (
      <View style={styles.chip}>
       <Text style={styles.chipText}>empty</Text>
      </View>
     ) : null}
     {current?.divergent ? (
      <View style={[styles.chip, { borderColor: palette.conflict }]}>
       <Text style={[styles.chipText, { color: palette.conflict }]}>divergent</Text>
      </View>
     ) : null}
     {current?.bookmarks.map((bookmark) => (
      <View key={bookmark} style={[styles.chip, styles.chipActive]}>
       <Text style={styles.chipTextActive}>{bookmark}</Text>
      </View>
     ))}
     {current?.tags.map((tag) => (
      <View key={tag} style={styles.chip}>
       <Text style={styles.chipText}>{tag}</Text>
      </View>
     ))}
    </View>
    <Text style={styles.description} numberOfLines={3}>
     {current?.description.trim() || "No description yet"}
    </Text>
    {current ? (
     <Text style={styles.muted} numberOfLines={1}>
      {current.author} · {current.age}
      {current.committer && current.committer !== current.author
       ? ` · committed by ${current.committer}`
       : ""}
     </Text>
    ) : null}
   </View>

   {snapshot.conflicts.length > 0 ? (
    <View style={styles.banner}>
     <Text style={[styles.buttonText, { color: palette.conflict }]}>
      {snapshot.conflicts.length} conflicted file{snapshot.conflicts.length === 1 ? "" : "s"}
     </Text>
     <Text style={styles.muted}>{snapshot.conflicts.join(", ")}</Text>
    </View>
   ) : null}

   {snapshot.error ? (
    <View style={styles.banner}>
     <Text style={[styles.buttonText, { color: palette.removedCount }]}>
      jj could not read this workspace
     </Text>
     <Text style={styles.muted}>{snapshot.error}</Text>
    </View>
   ) : null}

   <View style={styles.toolbar}>
    <RevisionTrigger
     label={revisionName}
     open={picker !== null}
     onPress={() => setPicker("select")}
     palette={palette}
     theme={theme}
     metrics={metrics}
     maxWidth={layout.compact ? 150 : 240}
    />
   </View>

   <View style={styles.toolbar}>
    <Pressable
     accessibilityRole="button"
     accessibilityLabel={treeVisible ? "Hide the sidebar" : "Show the sidebar"}
     onPress={() => setTreeVisible(!treeVisible)}
     style={[styles.button, treeVisible ? styles.buttonActive : null]}
    >
     <Icon
      name="PanelRight"
      size={14}
      color={treeVisible ? theme.colors.accentForeground : palette.filePath}
     />
     <Text style={treeVisible ? styles.buttonTextActive : styles.buttonText}>
      {layout.compact && treeVisible ? "Diff" : "Sidebar"}
     </Text>
    </Pressable>

    <Pressable
     accessibilityRole="button"
     accessibilityLabel={split ? "Switch to unified diff" : "Switch to split diff"}
     onPress={() => setSplit((value) => !value)}
     disabled={layout.compact}
     style={[styles.button, layout.compact ? styles.disabled : null]}
    >
     <Icon name={split ? "AlignJustify" : "Columns"} size={14} color={palette.filePath} />
     <Text style={styles.buttonText}>{split ? "Unified" : "Split"}</Text>
    </Pressable>

    <Pressable
     accessibilityRole="button"
     accessibilityLabel="Start a new change"
     onPress={() => runAction.mutate({ directory, action: "new" })}
     disabled={busy}
     style={[styles.button, busy ? styles.disabled : null]}
    >
     <Icon name="Plus" size={14} color={palette.filePath} />
     <Text style={styles.buttonText}>New change</Text>
    </Pressable>

    <Pressable
     accessibilityRole="button"
     accessibilityLabel="Undo the last jj operation"
     onPress={() => runAction.mutate({ directory, action: "undo" })}
     disabled={busy}
     style={[styles.button, busy ? styles.disabled : null]}
    >
     <Icon name="Undo2" size={14} color={palette.filePath} />
     <Text style={styles.buttonText}>Undo</Text>
    </Pressable>

    <Pressable
     accessibilityRole="button"
     accessibilityLabel="Refresh the diff"
     onPress={() => {
      void queryClient.invalidateQueries({ queryKey: ["jj"] });
     }}
     style={styles.button}
    >
     <Icon name="RefreshCw" size={14} color={palette.filePath} />
     <Text style={styles.buttonText}>Refresh</Text>
    </Pressable>
   </View>

   {diffQuery.data?.truncated ? (
    <View style={styles.banner}>
     <Text style={styles.buttonText}>This diff is truncated</Text>
     <Text style={styles.muted}>
      Only the first files are shown. Pick a narrower revision or a single path.
     </Text>
    </View>
   ) : null}

   {diffQuery.data?.error ? (
    <View style={styles.banner}>
     <Text style={[styles.buttonText, { color: palette.removedCount }]}>{diffQuery.data.error}</Text>
    </View>
   ) : null}

   <View
    style={styles.body}
    onPointerMove={onDragMove}
    onPointerUp={endDrag}
    onPointerLeave={endDrag}
    onPointerCancel={endDrag}
   >
    {treeVisible && layout.compact ? null : orderedFiles.length === 0 ? (
     <View style={styles.center}>
      <Text style={styles.muted}>
       {diffQuery.isPending
        ? "Loading the diff…"
        : isEmpty
         ? "This change is empty. Edits an agent makes will appear here."
         : "No content changes in this revision."}
      </Text>
     </View>
    ) : (
     <PierreDiffView
      files={orderedFiles}
      split={split}
      palette={palette}
      onRevertFile={revset === "@" ? setPendingRevert : undefined}
      onHunkAction={onHunkAction}
      handleRef={diffRef}
     />
    )}

    {treeVisible && !layout.compact ? (
     <View
      style={[styles.sidebarHandle, resizeCursor]}
      accessibilityLabel="Resize the sidebar"
      onPointerDown={(event) => {
       // Without this the browser starts a text selection over the pane, turns
       // that into a native drag and cancels the pointer stream mid-gesture.
       event.preventDefault();
       sidebarDrag.current = {
        startX: event.nativeEvent.pageX,
        startWidth: sidebarWidthRef.current,
       };
      }}
     >
      <View style={styles.sidebarHandleLine} />
     </View>
    ) : null}

    {treeVisible ? (
     <View
      style={layout.compact ? styles.railWide : [styles.rail, { width: sidebarWidth }]}
      onLayout={(event) => {
       sidebarHeightRef.current = event.nativeEvent.layout.height;
      }}
     >
      <FileTreeRail
       rows={fileTree.rows}
       collapsed={collapsedFolders}
       selectedPath={selectedPath}
       checked={checkedFiles}
       allChecked={allFilesChecked}
       busy={busy}
       onToggleChecked={toggleChecked}
       onToggleCheckAll={toggleCheckAll}
       onSquashChecked={askWhereCheckedGo}
       allCollapsed={allCollapsed}
       loading={diffQuery.isPending}
       flex={filesFlex}
       minimized={filesMinimized}
       onToggleMinimized={() => setFilesMinimized((value) => !value)}
       onToggleFolder={toggleFolder}
       onToggleCollapseAll={toggleCollapseAll}
       onSelectFile={selectFile}
       palette={palette}
       metrics={metrics}
       theme={theme}
      />
      {filesMinimized || revisionsMinimized ? (
       <View style={styles.railDivider} />
      ) : (
       <View
        style={[styles.splitHandle, splitCursor]}
        accessibilityLabel="Resize the sidebar sections"
        onPointerDown={(event) => {
         event.preventDefault();
         splitDrag.current = {
          startY: event.nativeEvent.pageY,
          startRatio: splitRatioRef.current,
         };
        }}
       >
        <View style={styles.splitHandleLine} />
       </View>
      )}
      <GraphView
       changes={snapshot?.graph ?? []}
       selectedChangeId={selectedChangeId}
       currentChangeId={snapshot?.current?.changeId ?? null}
       selection={selection}
       drag={drag}
       loading={snapshotQuery.isPending}
       flex={revisionsFlex}
       minimized={revisionsMinimized}
       onToggleMinimized={() => setRevisionsMinimized((value) => !value)}
       onSelect={selectRevision}
       onDragStart={startDrag}
       onDragOver={onDragOver}
       onOpenActions={() => setActionsOpen(true)}
       palette={palette}
       metrics={metrics}
       theme={theme}
      />
      {layout.compact || revisionsMinimized ? null : (
       <BranchBar
        selectionLabel={revisionName}
        bookmarks={selectedBookmarks}
        bookmarkName={bookmarkName}
        onBookmarkNameChange={setBookmarkName}
        pendingDelete={pendingBookmarkDelete}
        busy={busy}
        onSet={setBookmark}
        onDelete={deleteBookmark}
        onConfirmDelete={confirmBookmarkDelete}
        onCancelDelete={() => setPendingBookmarkDelete(null)}
        onMerge={() => setPicker("merge")}
        onRebase={() => setPicker("rebase")}
        palette={palette}
        metrics={metrics}
        theme={theme}
       />
      )}
     </View>
    ) : null}
   </View>

   {pendingRevert ? (
    <View style={styles.confirmBar}>
     <Text style={[styles.muted, { flex: 1 }]} numberOfLines={2}>
      Discard changes to {pendingRevert}?
     </Text>
     <Pressable
      accessibilityRole="button"
      accessibilityLabel="Confirm discard"
      onPress={() => runAction.mutate({ directory, action: "restore", paths: [pendingRevert] })}
      disabled={busy}
      style={[styles.button, { borderColor: palette.removedCount }, busy ? styles.disabled : null]}
     >
      <Text style={[styles.buttonText, { color: palette.removedCount }]}>Discard</Text>
     </Pressable>
     <Pressable
      accessibilityRole="button"
      accessibilityLabel="Cancel discard"
      onPress={() => setPendingRevert(null)}
      style={styles.button}
     >
      <Text style={styles.buttonText}>Cancel</Text>
     </Pressable>
    </View>
   ) : null}

   {revset === "@" ? (
    <View style={styles.composer}>
     <TextInput
      style={styles.input}
      placeholder={isEmpty ? "Describe the next change…" : "Describe this change…"}
      placeholderTextColor={palette.filePathMuted}
      value={message}
      onChangeText={setMessage}
      multiline
      accessibilityLabel="Change description"
     />
     <View style={styles.row}>
      <Pressable
       accessibilityRole="button"
       accessibilityLabel="Commit this change and start the next"
       onPress={() => runAction.mutate({ directory, action: "commit", message })}
       disabled={!canCommit || isEmpty}
       style={[
        styles.button,
        styles.buttonPrimary,
        !canCommit || isEmpty ? styles.disabled : null,
       ]}
      >
       <Icon name="GitCommitVertical" size={14} color={theme.colors.accentForeground} />
       <Text style={styles.buttonTextPrimary}>Commit</Text>
      </Pressable>
      <Pressable
       accessibilityRole="button"
       accessibilityLabel="Set the description without starting a new change"
       onPress={() => runAction.mutate({ directory, action: "describe", message })}
       disabled={!canCommit}
       style={[styles.button, !canCommit ? styles.disabled : null]}
      >
       <Icon name="Tag" size={14} color={palette.filePath} />
       <Text style={styles.buttonText}>Describe</Text>
      </Pressable>
     </View>
    </View>
   ) : null}

   {picker ? (
    <RevisionPickerOverlay
     title={PICKER_TITLE[picker]}
     options={revisionOptions}
     value={revset}
     onSelect={pickRevision}
     onClose={() => {
      setPicker(null);
      setPickerTargets(null);
     }}
     palette={palette}
     theme={theme}
     metrics={metrics}
     compact={layout.compact}
    />
   ) : null}

   {actionsOpen ? (
    <RevisionActionsOverlay
     selectionLabel={bulk ? `${targets.length} revisions` : revisionName}
     actions={overlayActions}
     onRun={bulk ? runBulkAction : runRevisionAction}
     onClose={() => setActionsOpen(false)}
     busy={busy}
     bulk={bulk}
     palette={palette}
     metrics={metrics}
     theme={theme}
     compact={layout.compact}
    />
   ) : null}

   {drag ? (
    <View
     // The HUD sits under the pointer, which is where the drop is: it must not
     // take the pointer's place, or the row it names could never be reached.
     pointerEvents="none"
     accessibilityLabel="Drag action"
     style={[
      styles.dragHud,
      layout.platform === "web" ? DRAG_HUD_FIXED : null,
      { left: drag.x + 14, top: drag.y + 14 },
     ]}
    >
     <Text style={styles.dragHudText} numberOfLines={1}>
      {dragLabel} {drag.targetId === null ? "…" : drag.targetId.slice(0, 8)}
     </Text>
    </View>
   ) : null}
  </View>
 );
}
