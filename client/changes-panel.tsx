import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { PointerEvent, ViewStyle } from "react-native";
import { actionRpc, diffRpc, snapshotRpc } from "../shared/contracts";
import {
 bumpEpoch,
 focusFile,
 openDiffPane,
 openFile,
 selectRevision as selectPaneRevision,
 usePaneState,
} from "./pane-store";
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
} from "./gestures";
import { GraphView } from "./graph-view";
import { useHeldKeys } from "./held-keys";
import { SPLIT_INITIAL, draggedSplitRatio } from "./panel-layout";
import { BranchBar } from "./branch-bar";
import { buildRevisionOptions, RevisionPickerOverlay } from "./revision-picker";
import { RevisionActionsOverlay, type RevisionAction, type RevisionActionId } from "./revision-actions";
import { paneMetrics, POLL_MS } from "./pane-shared";
import { buildPalette } from "./palette";


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

 const paneState = usePaneState(workspaceId);
 const { revset, epoch } = paneState;
 const [message, setMessage] = useState("");
 const [picker, setPicker] = useState<RevisionPickerPurpose | null>(null);
 const [pickerTargets, setPickerTargets] = useState<string[] | null>(null);
 const [bookmarkName, setBookmarkName] = useState("");
 const [pendingBookmarkDelete, setPendingBookmarkDelete] = useState<string | null>(null);
 const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set());
 const [filesMinimized, setFilesMinimized] = useState(false);
 const [revisionsMinimized, setRevisionsMinimized] = useState(false);
 const [selectedPath, setSelectedPath] = useState<string | null>(null);
 const [splitRatio, setSplitRatio] = useState(SPLIT_INITIAL);
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
 const splitRatioRef = useRef(splitRatio);
 const splitHeightRef = useRef(0);
 const splitDrag = useRef<{ startY: number; startRatio: number } | null>(null);

 useEffect(() => {
  splitRatioRef.current = splitRatio;
 }, [splitRatio]);

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

  if (splitDrag.current) {
   const split = splitDrag.current;
   const deltaY = pageY - split.startY;
   if (Math.abs(deltaY) >= 2) {
    setSplitRatio(draggedSplitRatio(split.startRatio, deltaY, splitHeightRef.current));
   }
  }
 };

 const endDrag = () => {
  splitDrag.current = null;
  const revision = dragRef.current;
  dragRef.current = null;
  if (!revision) return;
  setDrag(null);
  if (!revision.active) return;
  suppressSelect.current = true;
  const target = revision.targetId;
  if (target === null || target === revision.changeId) return;
  if (revision.bookmark !== null) {
   runAction.mutate({ directory: directory ?? "", action: "bookmark-set", name: revision.bookmark, revset: target });
   return;
  }
  runAction.mutate({ directory: directory ?? "", ...dropCall(dropGesture(held), revision.changeId, target) });
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
  () => paneMetrics(layout.compact, layout.platform),
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
   bumpEpoch(workspaceId);
   toast.show(result.output || "Done", { variant: "success" });
   setMessage("");
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
   if (done > 0) bumpEpoch(workspaceId);
   for (const failure of failures) toast.error(failure.error ?? "jj command failed.");
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
 useEffect(() => {
  void queryClient.invalidateQueries({ queryKey: ["jj"] });
 }, [epoch, queryClient]);

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

 const splitCursor = layout.platform === "web" ? HEIGHT_HANDLE : undefined;
 /** Bookmarks already on the selected revision, offered as names to reuse. */
 const selectedBookmarks =
  snapshot?.graph.find((change) => change.changeId === selectedChangeId)?.bookmarks ?? [];

 const styles = useMemo(
  () => ({
   screen: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
   },
   header: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
   },
   row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
   },
   changeId: {
    color: palette.filePathMuted,
    fontSize: metrics.fontSize,
    fontFamily: metrics.fontFamily,
   },
   description: {
    color: palette.filePath,
    fontSize: 14,
    fontWeight: "600" as const,
    flex: 1,
   },
   toolbar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    paddingHorizontal: 10,
    paddingBottom: 7,
    flexWrap: "wrap" as const,
   },
   button: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: palette.splitDivider,
   },
   buttonPrimary: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
   },
   buttonText: {
    color: palette.filePath,
    fontSize: metrics.fontSize,
   },
   buttonTextPrimary: {
    color: theme.colors.accentForeground,
    fontSize: metrics.fontSize,
   },
   muted: {
    color: palette.filePathMuted,
    fontSize: metrics.fontSize,
   },
   disabled: { opacity: 0.45 },
   splitHandle: { height: 7, justifyContent: "center" as const },
   splitHandleLine: { height: 1, backgroundColor: palette.splitDivider },
   railDivider: { height: 1, backgroundColor: palette.splitDivider },
   composer: {
    borderTopWidth: 1,
    borderColor: palette.splitDivider,
    padding: 10,
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
   dragHud: {
    position: "absolute" as const,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.accent,
   },
   dragHudText: {
    color: palette.filePath,
    fontSize: metrics.fontSize,
   },
  }),
  [palette, theme, metrics],
 );


 /** The graph names revisions by change id, but the diff pane keys its working-copy
  *  controls (composer, discard, in-place edit) on `@`. Picking the working copy's
  *  own row therefore selects `@`, or those controls could never come back. */
 const paneRevset = useCallback(
  (changeId: string) => (changeId === snapshot?.current?.changeId ? "@" : changeId),
  [snapshot?.current?.changeId],
 );

 /** File selection focuses the singleton diff pane at the selected file. */
 const selectFile = useCallback((path: string) => {
  setSelectedPath(path);
  focusFile(workspaceId, path);
  openDiffPane(workspaceId);
 }, [workspaceId]);

 /** The file tab reads the file at the revision this pane lists. */
 const openFileAtRevision = useCallback(
  (path: string) => openFile(workspaceId, path, revset),
  [revset, workspaceId],
 );

 /** Revision selection updates the graph and opens the matching diff. */
 const selectRevision = useCallback((changeId: string) => {
  if (suppressSelect.current) return;
  selectPaneRevision(workspaceId, paneRevset(changeId));
  setSelectedPath(null);
  setSelection((current) => clickedSelection(current, changeId, held.additive));
  openDiffPane(workspaceId);
 }, [held.additive, paneRevset, workspaceId]);

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


 const pickRevision = useCallback((id: string) => {
  const purpose = picker;
  setPicker(null);
  if (purpose === "squash-files") {
   runAction.mutate({
    directory: directory ?? "",
    action: "squash",
    revset: selectedChangeId ?? undefined,
    target: id,
    paths: [...checkedFiles],
   }, {
    onSuccess: (result) => {
     if (result.ok) setCheckedPaths(new Set());
    },
   });
   return;
  }
  if (purpose === "merge" || purpose === "rebase" || purpose === "squash") {
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
  selectPaneRevision(workspaceId, paneRevset(id));
  setSelectedPath(null);
  openDiffPane(workspaceId);
 }, [checkedFiles, directory, paneRevset, picker, pickerTargets, runAction, runBulk, selectedChangeId, workspaceId]);

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
  <View style={styles.screen} testID="jj-changes">
   <View style={styles.header}>
    <View style={styles.row}>
     <Text style={styles.changeId}>
      {current?.changeId.slice(0, 8) ?? "--------"}
     </Text>
     <Text style={styles.description} numberOfLines={1}>
      {current?.description.trim() || "No description yet"}
     </Text>
    </View>
   </View>
   <View style={styles.toolbar}>
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
     accessibilityLabel="Refresh changes"
     onPress={() => {
      void queryClient.invalidateQueries({ queryKey: ["jj"] });
     }}
     style={styles.button}
    >
     <Icon name="RefreshCw" size={14} color={palette.filePath} />
     <Text style={styles.buttonText}>Refresh</Text>
    </Pressable>
   </View>
   <View
    style={[styles.screen, { minHeight: 0 }]}
    onLayout={(event) => {
     splitHeightRef.current = event.nativeEvent.layout.height;
    }}
    onPointerMove={onDragMove}
    onPointerUp={endDrag}
    onPointerLeave={endDrag}
    onPointerCancel={endDrag}
   >
    <View style={{ flex: filesFlex, minHeight: filesMinimized ? 32 : 0 }}>
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
      flex={1}
      minimized={filesMinimized}
      onToggleMinimized={() => setFilesMinimized((value) => !value)}
      onToggleFolder={toggleFolder}
      onToggleCollapseAll={toggleCollapseAll}
      onSelectFile={selectFile}
      onOpenFile={openFileAtRevision}
      palette={palette}
      metrics={metrics}
      theme={theme}
     />
    </View>
    {filesMinimized || revisionsMinimized ? (
     <View style={styles.railDivider} />
    ) : (
     <View
      style={[styles.splitHandle, splitCursor]}
      accessibilityLabel="Resize the changes sections"
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
    <View style={{ flex: revisionsFlex, minHeight: revisionsMinimized ? 32 : 0 }}>
     <GraphView
      changes={snapshot?.graph ?? []}
      selectedChangeId={selectedChangeId}
      currentChangeId={snapshot?.current?.changeId ?? null}
      selection={selection}
      drag={drag}
      loading={snapshotQuery.isPending}
      flex={1}
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
    </View>
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
   </View>
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
