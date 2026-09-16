import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { actionRpc, diffRpc, snapshotRpc } from "../shared/contracts";
import { FileHeader, HunkHeader, NoteRow, SplitLine, UnifiedLine, monoFont } from "./diff-view";
import { buildPalette } from "./palette";
import { buildRows, type DiffRow } from "./rows";

/**
 * The working copy changes under the panel as agents edit files, so the
 * snapshot and diff are polled. jj snapshots incrementally, which keeps the
 * repeat cost well below the first read of a repository.
 */
const POLL_MS = 5000;

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
 const [split, setSplit] = useState(!layout.compact);
 const [message, setMessage] = useState("");
 const [pendingRevert, setPendingRevert] = useState<string | null>(null);

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
 const { rows, fileRowIndex } = useMemo(() => buildRows(files, split), [files, split]);

 const styles = useMemo(
  () => ({
   screen: { flex: 1, backgroundColor: theme.colors.surface0 },
   header: { paddingHorizontal: layout.compact ? 12 : 16, paddingTop: 12, paddingBottom: 6, gap: 6 },
   row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
   wrapRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    flexWrap: "wrap" as const,
   },
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
   strip: { flexGrow: 0 },
   stripRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
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
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip}>
     <View style={styles.stripRow}>
      {[
       { id: "@", label: "working copy" },
       { id: "@-", label: "parent" },
       ...snapshot.recent
        .filter((change) => change.changeId !== current?.changeId)
        .slice(0, 15)
        .map((change) => ({
         id: change.changeId,
         label: change.description.trim() || change.changeId.slice(0, 8),
        })),
      ].map((option) => (
       <Pressable
        key={option.id}
        accessibilityRole="button"
        accessibilityLabel={`Show diff for ${option.label}`}
        onPress={() => setRevset(option.id)}
        style={[styles.chip, revset === option.id ? styles.chipActive : null]}
       >
        <Text
         style={revset === option.id ? styles.chipTextActive : styles.chipText}
         numberOfLines={1}
        >
         {option.label.slice(0, 40)}
        </Text>
       </Pressable>
      ))}
     </View>
    </ScrollView>
   </View>

   {files.length > 1 ? (
    <View style={styles.toolbar}>
     <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip}>
      <View style={styles.stripRow}>
       {files.map((file) => (
        <Pressable
         key={file.path}
         accessibilityRole="button"
         accessibilityLabel={`Jump to ${file.path}`}
         onPress={() => scrollToFile(file.path)}
         style={styles.chip}
        >
         <Text style={styles.chipText} numberOfLines={1}>
          {file.path.split("/").pop()}
         </Text>
        </Pressable>
       ))}
      </View>
     </ScrollView>
    </View>
   ) : null}

   <View style={styles.toolbar}>
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

   <FlatList
    ref={listRef}
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
  </View>
 );
}
