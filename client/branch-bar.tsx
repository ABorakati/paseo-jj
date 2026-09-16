import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { DiffPalette } from "./palette";

interface Metrics {
 fontSize: number;
 fontFamily: string;
}

interface BranchBarProps {
 /** The revision every action here applies to, named the way the trigger names
  *  it so the two never disagree. */
 selectionLabel: string;
 bookmarkName: string;
 onBookmarkNameChange(value: string): void;
 pendingDelete: string | null;
 busy: boolean;
 onBookmark(kind: "create" | "set" | "delete"): void;
 onConfirmDelete(): void;
 onCancelDelete(): void;
 onMerge(): void;
 onRebase(): void;
 onViewDiff(): void;
 palette: DiffPalette;
 metrics: Metrics;
 theme: PluginTheme;
}

/**
 * Branch controls for the selected revision. jj has no branch object to check
 * out: a bookmark is a movable name for a revision, and a merge is a new
 * revision with two parents, so both read as "point a name here" and "combine
 * these two".
 */
export function BranchBar({
 selectionLabel,
 bookmarkName,
 onBookmarkNameChange,
 pendingDelete,
 busy,
 onBookmark,
 onConfirmDelete,
 onCancelDelete,
 onMerge,
 onRebase,
 onViewDiff,
 palette,
 metrics,
 theme,
}: BranchBarProps) {
 const styles = useMemo(
  () => ({
   bar: {
    borderBottomWidth: 1,
    borderColor: palette.splitDivider,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
   },
   row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
   label: { color: palette.filePathMuted, fontSize: metrics.fontSize - 1 },
   selection: { color: palette.filePath, fontSize: metrics.fontSize, flexShrink: 1 },
   input: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 90,
    color: palette.filePath,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: palette.splitDivider,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    fontSize: metrics.fontSize,
   },
   button: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: palette.splitDivider,
   },
   buttonPrimary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
   buttonText: { color: palette.filePath, fontSize: metrics.fontSize },
   buttonTextPrimary: { color: theme.colors.accentForeground, fontSize: metrics.fontSize },
   disabled: { opacity: 0.45 },
   confirm: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: theme.colors.surface1,
    borderLeftWidth: 3,
    borderLeftColor: palette.removedCount,
   },
  }),
  [metrics, palette, theme],
 );

 const canName = bookmarkName.trim().length > 0 && !busy;

 return (
  <View style={styles.bar}>
   <View style={styles.row}>
    <Text style={styles.label}>at</Text>
    <Text style={styles.selection} numberOfLines={1}>
     {selectionLabel}
    </Text>
    <View style={{ flex: 1 }} />
    <Pressable
     accessibilityRole="button"
     accessibilityLabel="View this revision's diff"
     onPress={onViewDiff}
     style={styles.button}
    >
     <Icon name="FileDiff" size={13} color={palette.filePath} />
     <Text style={styles.buttonText}>Diff</Text>
    </Pressable>
   </View>

   {pendingDelete ? (
    <View style={styles.confirm}>
     <Text style={[styles.label, { flex: 1, color: palette.filePath }]} numberOfLines={2}>
      Delete bookmark {pendingDelete}? The deletion reaches remotes on the next push.
     </Text>
     <Pressable
      accessibilityRole="button"
      accessibilityLabel="Confirm bookmark deletion"
      onPress={onConfirmDelete}
      disabled={busy}
      style={[styles.button, busy ? styles.disabled : null]}
     >
      <Text style={[styles.buttonText, { color: palette.removedCount }]}>Delete</Text>
     </Pressable>
     <Pressable
      accessibilityRole="button"
      accessibilityLabel="Cancel bookmark deletion"
      onPress={onCancelDelete}
      style={styles.button}
     >
      <Text style={styles.buttonText}>Cancel</Text>
     </Pressable>
    </View>
   ) : (
    <View style={styles.row}>
     <TextInput
      style={styles.input}
      value={bookmarkName}
      onChangeText={onBookmarkNameChange}
      placeholder="bookmark name"
      placeholderTextColor={palette.filePathMuted}
      accessibilityLabel="Bookmark name"
     />
     <Pressable
      accessibilityRole="button"
      accessibilityLabel="Create the bookmark at this revision"
      onPress={() => onBookmark("create")}
      disabled={!canName}
      style={[styles.button, styles.buttonPrimary, !canName ? styles.disabled : null]}
     >
      <Text style={styles.buttonTextPrimary}>Create</Text>
     </Pressable>
     <Pressable
      accessibilityRole="button"
      accessibilityLabel="Move the bookmark to this revision"
      onPress={() => onBookmark("set")}
      disabled={!canName}
      style={[styles.button, !canName ? styles.disabled : null]}
     >
      <Text style={styles.buttonText}>Move</Text>
     </Pressable>
     <Pressable
      accessibilityRole="button"
      accessibilityLabel="Delete the bookmark"
      onPress={() => onBookmark("delete")}
      disabled={!canName}
      style={[styles.button, !canName ? styles.disabled : null]}
     >
      <Icon name="Trash2" size={13} color={palette.removedCount} />
     </Pressable>
    </View>
   )}

   <View style={styles.row}>
    <Pressable
     accessibilityRole="button"
     accessibilityLabel="Merge another revision into this one"
     onPress={onMerge}
     disabled={busy}
     style={[styles.button, busy ? styles.disabled : null]}
    >
     <Icon name="GitMerge" size={13} color={palette.filePath} />
     <Text style={styles.buttonText}>Merge with…</Text>
    </Pressable>
    <Pressable
     accessibilityRole="button"
     accessibilityLabel="Rebase this branch onto another revision"
     onPress={onRebase}
     disabled={busy}
     style={[styles.button, busy ? styles.disabled : null]}
    >
     <Icon name="MoveRight" size={13} color={palette.filePath} />
     <Text style={styles.buttonText}>Rebase onto…</Text>
    </Pressable>
   </View>
  </View>
 );
}
