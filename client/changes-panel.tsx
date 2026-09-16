import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { actionRpc, diffRpc, snapshotRpc } from "../shared/contracts";
import { FileHeader, HunkHeader, NoteRow, SplitLine, UnifiedLine, monoFont } from "./diff-view";
import { buildFileTree, orderFiles } from "./file-tree";
import { FileTreeRail } from "./file-tree-rail";
import { GraphView } from "./graph-view";
import { buildPalette } from "./palette";
import { BranchBar } from "./branch-bar";
import { buildRevisionOptions, RevisionPickerOverlay, RevisionTrigger } from "./revision-picker";
import { buildRows, type DiffRow } from "./rows";

/**
 * The working copy changes under the panel as agents edit files, so the
 * snapshot and diff are polled. jj snapshots incrementally, which keeps the
 * repeat cost well below the first read of a repository.
 */
const POLL_MS = 5000;

/** The picker is reused for the branch actions: the title and what a pick means
 *  change, the searchable list does not. */
type RevisionPickerPurpose = "select" | "merge" | "rebase";

const PICKER_TITLE: Record<RevisionPickerPurpose, string> = {
 select: "Choose a revision",
 merge: "Merge with…",
 rebase: "Rebase branch onto…",
};

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
 const listRef = useRef<FlatList<DiffRow>>(null);

 const [revset, setRevset] = useState("@");
 // Unified reads top to bottom and needs no horizontal room, which is what this
 // pane usually has. Split stays a click away on a wide layout.
 const [split, setSplit] = useState(false);
 const [message, setMessage] = useState("");
 const [pendingRevert, setPendingRevert] = useState<string | null>(null);
 const [picker, setPicker] = useState<RevisionPickerPurpose | null>(null);
 const [bookmarkName, setBookmarkName] = useState("");
 const [pendingBookmarkDelete, setPendingBookmarkDelete] = useState<string | null>(null);
 const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set());
 const [treeVisible, setTreeVisible] = useState(!layout.compact);
 const [selectedPath, setSelectedPath] = useState<string | null>(null);
 const [mode, setMode] = useState<"diff" | "graph">("diff");

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

 const snapshot = snapshotQuery.data;
 const files = useMemo(() => diffQuery.data?.files ?? [], [diffQuery.data]);
 // The tree is the ordering authority for both surfaces: the rail lists files
 // in this sequence and the diff renders it, so a row can never scroll to a
 // file that sits somewhere else in the list.
 const orderedFiles = useMemo(() => orderFiles(files), [files]);
 const fileTree = useMemo(() => buildFileTree(files, collapsedFolders), [files, collapsedFolders]);
 const { rows, fileRowIndex } = useMemo(() => buildRows(orderedFiles, split), [orderedFiles, split]);
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
 const allCollapsed =
  fileTree.folderPaths.length > 0 &&
  fileTree.folderPaths.every((path) => collapsedFolders.has(path));

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
   graphPane: { flex: 1, minHeight: 0 },
   list: { flex: 1 },
   rail: {
    width: 240,
    flexShrink: 0,
    borderLeftWidth: 1,
    borderColor: palette.splitDivider,
   },
   railWide: { flex: 1 },
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
  }),
  [palette, theme, metrics, layout.compact],
 );

 const scrollToFile = useCallback(
  (path: string) => {
   const index = fileRowIndex.get(path);
   if (index === undefined) return;
   listRef.current?.scrollToIndex({ index, animated: true });
  },
  [fileRowIndex],
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

 /** A pick means whatever the picker was opened for: a revision to read, a
  *  second parent to merge, or a destination to rebase onto. */
 const pickRevision = useCallback(
  (id: string) => {
   const purpose = picker;
   setPicker(null);
   if (purpose === "merge" || purpose === "rebase") {
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
  [directory, picker, runAction, selectedChangeId],
 );

 const runBookmark = useCallback(
  (kind: "create" | "set" | "delete") => {
   const name = bookmarkName.trim();
   if (!name) return;
   if (kind === "delete") {
    // Deleting a bookmark is published on the next push, so it is confirmed.
    setPendingBookmarkDelete(name);
    return;
   }
   runAction.mutate({
    directory: directory ?? "",
    action: kind === "create" ? "bookmark-create" : "bookmark-set",
    name,
    revset: selectedChangeId ?? undefined,
   });
  },
  [bookmarkName, directory, runAction, selectedChangeId],
 );

 const confirmBookmarkDelete = useCallback(() => {
  const name = pendingBookmarkDelete;
  if (!name) return;
  runAction.mutate({ directory: directory ?? "", action: "bookmark-delete", name });
 }, [directory, pendingBookmarkDelete, runAction]);

 const renderRow = useCallback(
  ({ item }: { item: DiffRow }) => {
   if (item.kind === "file") {
    return (
     <FileHeader
      file={item.file}
      palette={palette}
      metrics={metrics}
      compact={layout.compact}
      onRevert={revset === "@" ? () => setPendingRevert(item.file.path) : undefined}
     />
    );
   }
   if (item.kind === "hunk") return <HunkHeader header={item.header} palette={palette} metrics={metrics} />;
   if (item.kind === "line") return <UnifiedLine line={item.line} palette={palette} metrics={metrics} />;
   if (item.kind === "split") {
    return <SplitLine left={item.left} right={item.right} palette={palette} metrics={metrics} />;
   }
   return <NoteRow text={item.text} palette={palette} metrics={metrics} />;
  },
  [palette, metrics, layout.compact, revset],
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
 const busy = runAction.isPending;

 return (
  <View style={styles.screen}>
   <View style={styles.header}>
    <View style={styles.row}>
     <Text style={styles.changeId}>{current?.changeId.slice(0, 8) ?? "--------"}</Text>
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
     {current?.bookmarks.map((bookmark) => (
      <View key={bookmark} style={[styles.chip, styles.chipActive]}>
       <Text style={styles.chipTextActive}>{bookmark}</Text>
      </View>
     ))}
    </View>
    <Text style={styles.description} numberOfLines={3}>
     {current?.description.trim() || "No description yet"}
    </Text>
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
     accessibilityLabel={treeVisible ? "Hide the file tree" : "Show the file tree"}
     onPress={() => {
      const next = !treeVisible;
      setTreeVisible(next);
      // The rail navigates the diff, so showing it returns to the diff.
      if (next) setMode("diff");
     }}
     style={[styles.button, treeVisible && mode === "diff" ? styles.buttonActive : null]}
    >
     <Icon
      name="ListTree"
      size={14}
      color={treeVisible && mode === "diff" ? theme.colors.accentForeground : palette.filePath}
     />
     <Text style={treeVisible && mode === "diff" ? styles.buttonTextActive : styles.buttonText}>
      {layout.compact && treeVisible && mode === "diff" ? "Diff" : "Files"}
     </Text>
    </Pressable>

    <Pressable
     accessibilityRole="button"
     accessibilityLabel={mode === "graph" ? "Show the diff" : "Show the revision graph"}
     onPress={() => setMode((value) => (value === "graph" ? "diff" : "graph"))}
     style={[styles.button, mode === "graph" ? styles.buttonActive : null]}
    >
     <Icon
      name="GitFork"
      size={14}
      color={mode === "graph" ? theme.colors.accentForeground : palette.filePath}
     />
     <Text style={mode === "graph" ? styles.buttonTextActive : styles.buttonText}>Graph</Text>
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

   {mode === "graph" ? (
    <View style={styles.graphPane}>
     <BranchBar
      selectionLabel={revisionName}
      bookmarkName={bookmarkName}
      onBookmarkNameChange={setBookmarkName}
      pendingDelete={pendingBookmarkDelete}
      busy={busy}
      onBookmark={runBookmark}
      onConfirmDelete={confirmBookmarkDelete}
      onCancelDelete={() => setPendingBookmarkDelete(null)}
      onMerge={() => setPicker("merge")}
      onRebase={() => setPicker("rebase")}
      onViewDiff={() => setMode("diff")}
      palette={palette}
      metrics={metrics}
      theme={theme}
     />
     <GraphView
      changes={snapshot?.graph ?? []}
      selectedChangeId={selectedChangeId}
      currentChangeId={snapshot?.current?.changeId ?? null}
      loading={snapshotQuery.isPending}
      onSelect={(changeId) => {
       setRevset(changeId);
       setSelectedPath(null);
      }}
      palette={palette}
      metrics={metrics}
      theme={theme}
     />
    </View>
   ) : (
    <View style={styles.body}>
     {treeVisible && layout.compact ? null : (
      <FlatList
       ref={listRef}
       style={styles.list}
       testID="jj-diff"
       data={rows}
       keyExtractor={(item) => item.key}
       renderItem={renderRow}
       initialNumToRender={30}
       maxToRenderPerBatch={30}
       windowSize={11}
       removeClippedSubviews
       onScrollToIndexFailed={(info) => {
        // Rows are variable height, so an unmeasured index cannot be scrolled
        // to directly. Estimate, then retry once the row has been rendered.
        listRef.current?.scrollToOffset({
         offset: info.averageItemLength * info.index,
         animated: false,
        });
        setTimeout(() => {
         listRef.current?.scrollToIndex({ index: info.index, animated: true });
        }, 120);
       }}
       ListEmptyComponent={
        <View style={styles.center}>
         <Text style={styles.muted}>
          {diffQuery.isPending
           ? "Loading the diff…"
           : isEmpty
            ? "This change is empty. Edits an agent makes will appear here."
            : "No content changes in this revision."}
         </Text>
        </View>
       }
      />
     )}

     {treeVisible ? (
      <View style={layout.compact ? styles.railWide : styles.rail}>
       <FileTreeRail
        rows={fileTree.rows}
        collapsed={collapsedFolders}
        selectedPath={selectedPath}
        allCollapsed={allCollapsed}
        loading={diffQuery.isPending}
        onToggleFolder={toggleFolder}
        onToggleCollapseAll={toggleCollapseAll}
        onSelectFile={selectFile}
        palette={palette}
        metrics={metrics}
        theme={theme}
       />
      </View>
     ) : null}
    </View>
   )}

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
     onClose={() => setPicker(null)}
     palette={palette}
     theme={theme}
     metrics={metrics}
     compact={layout.compact}
    />
   ) : null}
  </View>
 );
}
