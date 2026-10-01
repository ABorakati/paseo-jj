import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { readFileRpc, writeFileRpc } from "../shared/contracts";
import { buildPalette } from "./palette";
import { paneMetrics, POLL_MS } from "./pane-shared";
import { bumpEpoch, focusFile, openDiffPane, selectRevision, usePaneState } from "./pane-store";
import { PierreFileView, type PierreFileHandle } from "./pierre-file";

type FileTarget = { path: string; revset: string };

/**
 * One whole file in an editor tab. The changes pane and the diff open it at the
 * revision they show; the working copy's files are editable and save through
 * the same guarded write the diff uses, every other revision is read-only.
 */
export function FilePane({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
 const workspace = useWorkspace(workspaceId, (snapshot) => ({ directory: snapshot.directory }));
 const directory = workspace?.directory ?? null;
 const { file: requested, epoch } = usePaneState(workspaceId);
 const callRead = useRpc(readFileRpc);
 const callWrite = useRpc(writeFileRpc);
 const toast = useToast();
 const queryClient = useQueryClient();
 const viewRef = useRef<PierreFileHandle>(null);
 const palette = useMemo(() => buildPalette(theme), [theme]);
 const metrics = useMemo(() => paneMetrics(layout.compact, layout.platform), [layout.compact, layout.platform]);

 /** The file on screen. It trails the requested one while there are unsaved
  *  edits, so opening another file never drops what was typed. */
 const [shown, setShown] = useState<FileTarget | null>(requested);
 const [dirty, setDirty] = useState(false);
 const [saving, setSaving] = useState(false);
 /** The text the editor was loaded with, or last saved: what is on disk as far
  *  as this tab knows, and what a write is checked against. */
 const [baseline, setBaseline] = useState<string | null>(null);
 /** Moves whenever the editor must drop what it holds and show `baseline`:
  *  Pierre keeps an open session's draft across item updates, so the view is
  *  remounted on this rather than only handed a new version. */
 const [version, setVersion] = useState(1);

 const pending = requested !== null && shown !== null &&
  (requested.path !== shown.path || requested.revset !== shown.revset);
 useEffect(() => {
  if (requested !== null && (shown === null || (pending && !dirty))) setShown(requested);
 }, [requested, shown, pending, dirty]);

 const editable = shown?.revset === "@";
 const fileQuery = useQuery({
  queryKey: ["jj", "file", directory, shown?.revset, shown?.path],
  queryFn: () => callRead({ directory: directory ?? "", revset: shown?.revset ?? "@", path: shown?.path ?? "" }),
  enabled: directory !== null && shown !== null,
  // An edit in progress is not interrupted by a re-read: the save guard is what
  // catches a file that changed underneath it.
  refetchInterval: dirty ? false : POLL_MS,
 });
 useEffect(() => {
  void queryClient.invalidateQueries({ queryKey: ["jj"] });
 }, [epoch, queryClient]);

 // A new file, or a read that changed it, replaces the editor's text — unless
 // there are edits the read would overwrite.
 const read = fileQuery.data?.text ?? null;
 useEffect(() => {
  if (read === null || dirty || read === baseline) return;
  setBaseline(read);
  setVersion((value) => value + 1);
 }, [read, dirty, baseline]);
 // Switching files starts clean: the previous file's baseline means nothing here.
 useEffect(() => {
  setBaseline(null);
  setDirty(false);
 }, [shown?.path, shown?.revset]);

 const onChange = useCallback((text: string) => setDirty(text !== baseline), [baseline]);

 const save = useCallback(async (): Promise<boolean> => {
  if (shown === null || !editable || baseline === null || saving) return false;
  const content = viewRef.current?.getText();
  if (content === null || content === undefined) return false;
  if (content === baseline) {
   setDirty(false);
   return true;
  }
  setSaving(true);
  try {
   const result = await callWrite({ directory: directory ?? "", path: shown.path, content, expected: baseline });
   if (!result.ok) {
    toast.error(result.error ?? "The write was refused.");
    return false;
   }
   setBaseline(content);
   setDirty(false);
   toast.show(`Wrote ${shown.path}`, { variant: "success" });
   bumpEpoch(workspaceId);
   return true;
  } catch (error) {
   toast.error(error instanceof Error ? error.message : "The daemon call failed.");
   return false;
  } finally {
   setSaving(false);
  }
 }, [baseline, callWrite, directory, editable, saving, shown, toast, workspaceId]);

 /** Drops the typed edits and shows the file as it was last read or saved. */
 const revert = useCallback(() => {
  setDirty(false);
  setVersion((value) => value + 1);
  void fileQuery.refetch();
 }, [fileQuery]);

 const showInDiff = useCallback(() => {
  if (shown === null) return;
  selectRevision(workspaceId, shown.revset);
  focusFile(workspaceId, shown.path);
  openDiffPane(workspaceId);
 }, [shown, workspaceId]);

 const styles = useMemo(
  () => ({
   screen: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
   header: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    paddingHorizontal: layout.compact ? 12 : 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderColor: palette.splitDivider,
   },
   path: {
    flexShrink: 1,
    color: palette.filePath,
    fontSize: metrics.fontSize + 1,
    fontFamily: metrics.fontFamily,
   },
   chip: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: palette.splitDivider,
   },
   chipText: { fontSize: metrics.fontSize - 1, color: palette.filePathMuted },
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
   primary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
   buttonText: { color: palette.filePath, fontSize: metrics.fontSize },
   primaryText: { color: theme.colors.accentForeground, fontSize: metrics.fontSize },
   disabled: { opacity: 0.45 },
   bar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    padding: 10,
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderColor: palette.splitDivider,
   },
   center: {
    flex: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    padding: 24,
    gap: 8,
   },
   muted: { color: palette.filePathMuted, fontSize: metrics.fontSize, textAlign: "center" as const },
  }),
  [layout.compact, metrics, palette, theme],
 );

 if (shown === null) {
  return (
   <View style={styles.center}>
    <Text style={styles.muted}>Open a file from jj changes or jj diff to see all of it here.</Text>
   </View>
  );
 }

 const canSave = editable && dirty && !saving;
 return (
  <View style={styles.screen} testID="jj-file">
   <View style={styles.header}>
    <Icon name="FileCode" size={15} color={palette.filePathMuted} />
    <Text style={styles.path} numberOfLines={1}>
     {shown.path}
    </Text>
    <View style={styles.chip}>
     <Text style={styles.chipText}>
      {editable ? "working copy" : `${shown.revset.slice(0, 8)} · read-only`}
     </Text>
    </View>
    {dirty ? <Text style={styles.chipText}>● unsaved</Text> : null}
    <View style={{ flex: 1 }} />
    {editable ? (
     <>
      <Pressable
       accessibilityRole="button"
       accessibilityLabel={`Revert unsaved changes to ${shown.path}`}
       onPress={revert}
       disabled={!dirty || saving}
       style={[styles.button, !dirty || saving ? styles.disabled : null]}
      >
       <Icon name="Undo2" size={14} color={palette.filePath} />
       <Text style={styles.buttonText}>Revert</Text>
      </Pressable>
      <Pressable
       accessibilityRole="button"
       accessibilityLabel={`Save ${shown.path}`}
       onPress={() => void save()}
       disabled={!canSave}
       style={[styles.button, styles.primary, canSave ? null : styles.disabled]}
      >
       <Icon name="Save" size={14} color={theme.colors.accentForeground} />
       <Text style={styles.primaryText}>Save</Text>
      </Pressable>
     </>
    ) : null}
    <Pressable
     accessibilityRole="button"
     accessibilityLabel={`Show ${shown.path} in the diff`}
     onPress={showInDiff}
     style={styles.button}
    >
     <Icon name="FileDiff" size={14} color={palette.filePath} />
     <Text style={styles.buttonText}>Diff</Text>
    </Pressable>
   </View>

   {pending && dirty ? (
    <View style={styles.bar}>
     <Text style={[styles.muted, { flex: 1, textAlign: "left" as const }]} numberOfLines={2}>
      {shown.path} has unsaved changes. Save or discard them to open {requested?.path}.
     </Text>
     <Pressable
      accessibilityRole="button"
      accessibilityLabel="Save and open the next file"
      onPress={() => void save()}
      disabled={saving}
      style={[styles.button, styles.primary, saving ? styles.disabled : null]}
     >
      <Text style={styles.primaryText}>Save</Text>
     </Pressable>
     <Pressable
      accessibilityRole="button"
      accessibilityLabel="Discard changes and open the next file"
      onPress={() => setDirty(false)}
      style={styles.button}
     >
      <Text style={[styles.buttonText, { color: palette.removedCount }]}>Discard</Text>
     </Pressable>
    </View>
   ) : null}

   {baseline !== null && fileQuery.data?.text !== null ? (
    <PierreFileView
     key={`${shown.revset}:${shown.path}:${version}`}
     path={shown.path}
     text={baseline}
     editable={editable}
     palette={palette}
     onChange={onChange}
     onSave={() => void save()}
     handleRef={viewRef}
    />
   ) : (
    <View style={styles.center}>
     <Text style={styles.muted}>
      {fileQuery.isError
       ? (fileQuery.error as Error).message
       : (fileQuery.data?.reason ?? `Reading ${shown.path}…`)}
     </Text>
    </View>
   )}
  </View>
 );
}
