import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { actionRpc, diffRpc, snapshotRpc, writeFileRpc } from "../shared/contracts";
import { orderFiles } from "./file-tree";
import {
 PierreDiffView,
 type FileEditAccess,
 type HunkActionInput,
 type PierreDiffHandle,
} from "./pierre-diff";
import { wholeFileText } from "./pierre-patch";
import { bumpEpoch, openFile, selectRevision, usePaneState } from "./pane-store";
import { buildPalette } from "./palette";
import { buildRevisionOptions, RevisionPickerOverlay, RevisionTrigger } from "./revision-picker";
import { paneMetrics, POLL_MS } from "./pane-shared";
import { useSquashHunks } from "./squash";

export function DiffPane({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
 const workspace = useWorkspace(workspaceId, (snapshot) => ({
  directory: snapshot.directory,
 }));
 const directory = workspace?.directory ?? null;
 const { revset, focus, epoch } = usePaneState(workspaceId);
 const callSnapshot = useRpc(snapshotRpc);
 const callDiff = useRpc(diffRpc);
 const callWriteFile = useRpc(writeFileRpc);
 const callAction = useRpc(actionRpc);
 const toast = useToast();
 const queryClient = useQueryClient();
 const diffRef = useRef<PierreDiffHandle>(null);
 const lastFocusNonce = useRef(0);
 const [pickerOpen, setPickerOpen] = useState(false);
 const [split, setSplit] = useState(false);
 const [pendingRevert, setPendingRevert] = useState<string | null>(null);
 const [restorePending, setRestorePending] = useState(false);
 /** State only disables the button on the next render; two clicks in one tick
  *  both see it unset. The ref closes that gap so one confirm runs one restore. */
 const restoreInFlight = useRef(false);
 /** Files shown open. Everything else is its header only, which is how a long
  *  change reads as a list; the file tree opens the file it jumps to. */
 const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
 const toggleExpanded = useCallback((path: string) => {
  setExpanded((current) => {
   const next = new Set(current);
   if (next.has(path)) next.delete(path);
   else next.add(path);
   return next;
  });
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
 const snapshot = snapshotQuery.data;
 const diffQuery = useQuery({
  queryKey: ["jj", "diff", directory, revset],
  queryFn: () => callDiff({ directory: directory ?? "", revset }),
  enabled: directory !== null && snapshot?.isRepo === true,
  refetchInterval: POLL_MS,
 });
 useEffect(() => {
  void queryClient.invalidateQueries({ queryKey: ["jj"] });
 }, [epoch, queryClient]);

 const orderedFiles = useMemo(
  () => orderFiles(diffQuery.data?.files ?? []),
  [diffQuery.data],
 );
 const allExpanded =
  orderedFiles.length > 0 && orderedFiles.every((file) => expanded.has(file.path));
 /** Pierre keys each rendered file by path, matching the tree's selected path. */
 useEffect(() => {
  if (
   !focus ||
   focus.nonce === lastFocusNonce.current ||
   diffQuery.isPending ||
   !orderedFiles.some((file) => file.path === focus.path)
  ) {
   return;
  }
  lastFocusNonce.current = focus.nonce;
  // The file opens before the scroll, so the jump lands on its lines and not on
  // a header with nothing under it.
  setExpanded((current) => (current.has(focus.path) ? current : new Set(current).add(focus.path)));
  const frame = requestAnimationFrame(() => {
   diffRef.current?.scrollToFile(focus.path);
  });
  return () => cancelAnimationFrame(frame);
 }, [focus?.nonce, focus?.path, diffQuery.isPending, orderedFiles]);

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
 /** Header details follow the selected revset, not only the working copy. */
 const displayed =
  revset === "@"
   ? snapshot?.current
   : revset === "@-"
    ? snapshot?.parent
    : snapshot?.graph.find((change) => change.changeId === revset);
 const revisionName =
  revisionOptions.find((option) => option.id === revset)?.label ||
  displayed?.description.trim() ||
  revset;

 const styles = useMemo(
  () => ({
   screen: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
   },
   header: {
    paddingHorizontal: layout.compact ? 12 : 16,
    paddingTop: 12,
    paddingBottom: 6,
    gap: 6,
   },
   row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    flexWrap: "wrap" as const,
   },
   id: {
    color: palette.filePathMuted,
    fontSize: metrics.fontSize,
    fontFamily: metrics.fontFamily,
   },
   description: {
    color: palette.filePath,
    fontSize: layout.compact ? 15 : 16,
    fontWeight: "600" as const,
   },
   muted: {
    color: palette.filePathMuted,
    fontSize: metrics.fontSize,
   },
   chip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: palette.splitDivider,
   },
   chipActive: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
   },
   chipText: {
    fontSize: metrics.fontSize,
    color: palette.filePathMuted,
   },
   chipTextActive: {
    color: theme.colors.accentForeground,
    fontSize: metrics.fontSize,
   },
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
   buttonText: {
    color: palette.filePath,
    fontSize: metrics.fontSize,
   },
   disabled: { opacity: 0.45 },
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
   center: {
    flex: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    padding: 24,
    gap: 8,
   },
   confirm: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    padding: 10,
    backgroundColor: theme.colors.surface1,
    borderTopWidth: 1,
    borderColor: palette.splitDivider,
   },
  }),
  [layout.compact, metrics, palette, theme],
 );

 /** The file tab reads the file at the revision this diff shows. */
 const openFileAtRevision = useCallback(
  (path: string) => openFile(workspaceId, path, revset),
  [revset, workspaceId],
 );

 const squashHunks = useSquashHunks(workspaceId);
 /**
  * Hunk buttons move one hunk into this revision's parent. The destination
  * must use the displayed revset so the server checks the same hunk numbers.
  */
 const onHunkAction = useCallback(
  (input: HunkActionInput) => {
   squashHunks({
    file: input.file,
    hunkIndexes: [input.hunkIndex],
    from: revset,
    into: `(${revset})-`,
   })
    .then(() => bumpEpoch(workspaceId))
    .catch((error: unknown) => {
     toast.show(
      error instanceof Error ? error.message : "jj refused to move that hunk",
     );
    });
  },
  [revset, squashHunks, toast, workspaceId],
 );

 /**
  * Inline editing needs complete file text, but the diff only carries hunks.
  * Read both sides from the root so every current line arrives as an addition.
  */
 const editAccess = useMemo<FileEditAccess | undefined>(() => {
  if (revset !== "@") return undefined;
  return {
   async read(path) {
    const [current, parent] = await Promise.all([
     callDiff({ directory: directory ?? "", revset: "root()..@", path }),
     callDiff({ directory: directory ?? "", revset: "root()..@-", path }),
    ]);
    const newText = wholeFileText(current.files);
    if (newText === null) {
     throw new Error(current.error ?? `The panel could not read ${path}.`);
    }
    return { oldText: wholeFileText(parent.files) ?? "", newText };
   },
   // `expected` is the read text, so the server rejects stale writes instead of
   // overwriting an edit that arrived after this read.
   async write({ path, content, expected }) {
    const result = await callWriteFile({
     directory: directory ?? "",
     path,
     content,
     expected,
    });
    if (result.ok) {
     toast.show(`Wrote ${path}`, { variant: "success" });
     bumpEpoch(workspaceId);
    } else {
     toast.error(result.error ?? "The write was refused.");
    }
    return result;
   },
   refused(message) {
    toast.error(message);
   },
  };
 }, [callDiff, callWriteFile, directory, revset, toast, workspaceId]);

 /** Keep the confirmation open on failure and report jj's success output. */
 const confirmDiscard = useCallback(async () => {
  if (pendingRevert === null || restoreInFlight.current) return;
  restoreInFlight.current = true;
  setRestorePending(true);
  try {
   const result = await callAction({
    directory: directory ?? "",
    action: "restore",
    paths: [pendingRevert],
   });
   if (!result.ok) {
    toast.error(result.error ?? "jj command failed.");
    return;
   }
   bumpEpoch(workspaceId);
   toast.show(result.output || "Done", { variant: "success" });
   setPendingRevert(null);
  } catch (error) {
   toast.error(error instanceof Error ? error.message : "The daemon call failed.");
  } finally {
   restoreInFlight.current = false;
   setRestorePending(false);
  }
 }, [callAction, directory, pendingRevert, toast, workspaceId]);

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

 return (
  <View style={styles.screen} testID="jj-diff">
   <View style={styles.header}>
    <View style={styles.row}>
     <Pressable
      accessibilityRole="button"
      accessibilityLabel="Copy the change id"
      onPress={() => {
       const id = displayed?.changeId;
       if (!id) return;
       void copyText(id)
        .then(() => toast.show(`Copied ${id}`, { variant: "success" }))
        .catch(() => toast.error("Could not copy the change id."));
      }}
     >
      <Text style={styles.id}>{displayed?.changeId.slice(0, 8) ?? "--------"}</Text>
     </Pressable>
     {displayed?.conflicted ? (
      <View style={[styles.chip, { borderColor: palette.conflict }]}>
       <Text style={[styles.chipText, { color: palette.conflict }]}>conflicted</Text>
      </View>
     ) : null}
     {displayed?.empty ? (
      <View style={styles.chip}>
       <Text style={styles.chipText}>empty</Text>
      </View>
     ) : null}
     {displayed?.divergent ? (
      <View style={[styles.chip, { borderColor: palette.conflict }]}>
       <Text style={[styles.chipText, { color: palette.conflict }]}>divergent</Text>
      </View>
     ) : null}
     {displayed?.bookmarks.map((bookmark) => (
      <View key={bookmark} style={[styles.chip, styles.chipActive]}>
       <Text style={styles.chipTextActive}>{bookmark}</Text>
      </View>
     ))}
     {displayed?.tags.map((tag) => (
      <View key={tag} style={styles.chip}>
       <Text style={styles.chipText}>{tag}</Text>
      </View>
     ))}
    </View>
    <Text style={styles.description} numberOfLines={3}>
     {displayed?.description.trim() || "No description yet"}
    </Text>
    {displayed ? (
     <Text style={styles.muted} numberOfLines={1}>
      {displayed.author} · {displayed.age}
      {displayed.committer && displayed.committer !== displayed.author
       ? ` · committed by ${displayed.committer}`
       : ""}
     </Text>
    ) : null}
   </View>

   {snapshot.conflicts.length > 0 ? (
    <View style={styles.banner}>
     <Text style={[styles.buttonText, { color: palette.conflict }]}>
      {snapshot.conflicts.length} conflicted file
      {snapshot.conflicts.length === 1 ? "" : "s"}
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
     open={pickerOpen}
     onPress={() => setPickerOpen(true)}
     palette={palette}
     theme={theme}
     metrics={metrics}
     maxWidth={layout.compact ? 150 : 240}
    />
    <Pressable
     accessibilityRole="button"
     accessibilityLabel={split ? "Switch to unified diff" : "Switch to split diff"}
     onPress={() => setSplit((value) => !value)}
     disabled={layout.compact}
     style={[styles.button, layout.compact ? styles.disabled : null]}
    >
     <Icon
      name={split ? "AlignJustify" : "Columns"}
      size={14}
      color={palette.filePath}
     />
     <Text style={styles.buttonText}>{split ? "Unified" : "Split"}</Text>
    </Pressable>
    <Pressable
     accessibilityRole="button"
     accessibilityLabel={allExpanded ? "Collapse every file" : "Expand every file"}
     onPress={() =>
      setExpanded(allExpanded ? new Set() : new Set(orderedFiles.map((file) => file.path)))
     }
     disabled={orderedFiles.length <= 1}
     style={[styles.button, orderedFiles.length <= 1 ? styles.disabled : null]}
    >
     <Icon
      name={allExpanded ? "ChevronsDownUp" : "ChevronsUpDown"}
      size={14}
      color={palette.filePath}
     />
     <Text style={styles.buttonText}>{allExpanded ? "Collapse all" : "Expand all"}</Text>
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
     <Text style={[styles.buttonText, { color: palette.removedCount }]}>
      {diffQuery.data.error}
     </Text>
    </View>
   ) : null}

   {orderedFiles.length === 0 ? (
    <View style={styles.center}>
     <Text style={styles.muted}>
      {diffQuery.isPending
       ? "Loading the diff…"
       : displayed?.empty
        ? "This change is empty. Edits an agent makes will appear here."
        : "No content changes in this revision."}
     </Text>
    </View>
   ) : (
    <PierreDiffView
     files={orderedFiles}
     split={split}
     palette={palette}
     expanded={expanded}
     onToggleExpanded={toggleExpanded}
     onRevertFile={revset === "@" ? setPendingRevert : undefined}
     onHunkAction={onHunkAction}
     edit={editAccess}
     onOpenFile={openFileAtRevision}
     handleRef={diffRef}
    />
   )}

   {pendingRevert && revset === "@" ? (
    <View style={styles.confirm}>
     <Text style={[styles.muted, { flex: 1 }]} numberOfLines={2}>
      Discard changes to {pendingRevert}?
     </Text>
     <Pressable
      accessibilityRole="button"
      accessibilityLabel="Confirm discard"
      onPress={() => void confirmDiscard()}
      disabled={restorePending}
      style={[
       styles.button,
       { borderColor: palette.removedCount },
       restorePending ? styles.disabled : null,
      ]}
     >
      <Text style={[styles.buttonText, { color: palette.removedCount }]}>Discard</Text>
     </Pressable>
     <Pressable
      accessibilityRole="button"
      accessibilityLabel="Cancel discard"
      onPress={() => setPendingRevert(null)}
      disabled={restorePending}
      style={[styles.button, restorePending ? styles.disabled : null]}
     >
      <Text style={styles.buttonText}>Cancel</Text>
     </Pressable>
    </View>
   ) : null}
   {pickerOpen ? (
    <RevisionPickerOverlay
     title="Choose a revision"
     options={revisionOptions}
     value={revset}
     onSelect={(id) => {
      selectRevision(workspaceId, id);
      setPickerOpen(false);
     }}
     onClose={() => setPickerOpen(false)}
     palette={palette}
     theme={theme}
     metrics={metrics}
     compact={layout.compact}
    />
   ) : null}
  </View>
 );
}
