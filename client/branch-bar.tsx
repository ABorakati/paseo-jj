import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { DiffPalette } from "./palette";
import { RailHeader } from "./rail-header";

interface Metrics {
 fontSize: number;
 fontFamily: string;
}

interface BranchBarProps {
 /** The revision every action here applies to, named the way the trigger names
  *  it so the two never disagree. */
 selectionLabel: string;
 /** Bookmarks already on that revision. Clicking one fills the name field,
  *  since its name is the one thing the reader cannot guess. */
 bookmarks: string[];
 bookmarkName: string;
 onBookmarkNameChange(value: string): void;
 pendingDelete: string | null;
 busy: boolean;
 onSet(): void;
 onDelete(): void;
 onConfirmDelete(): void;
 onCancelDelete(): void;
 onMerge(): void;
 onRebase(): void;
 palette: DiffPalette;
 metrics: Metrics;
 theme: PluginTheme;
}

/**
 * Controls for the revision selected in the graph.
 *
 * A revision has one description and any number of bookmarks, and neither is
 * derived from the other: the description names the change, a bookmark is a
 * movable pointer to it that remotes can be told about. So this bar does the
 * pointer half — one name, one verb (`jj bookmark set` creates the bookmark or
 * moves it), plus the two ways to combine or move history.
 */
export function BranchBar({
 selectionLabel,
 bookmarks,
 bookmarkName,
 onBookmarkNameChange,
 pendingDelete,
 busy,
 onSet,
 onDelete,
 onConfirmDelete,
 onCancelDelete,
 onMerge,
 onRebase,
 palette,
 metrics,
 theme,
}: BranchBarProps) {
 const styles = useMemo(
  () => ({
   bar: { paddingHorizontal: 10, paddingBottom: 8, gap: 6 },
   target: { color: palette.filePathMuted, fontSize: metrics.fontSize - 1, flexShrink: 1 },
   row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
   input: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 70,
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
   chip: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: palette.splitDivider,
    maxWidth: "100%" as const,
   },
   chipText: { color: palette.filePathMuted, fontSize: metrics.fontSize - 1 },
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
   <RailHeader
    label="BOOKMARK"
    palette={palette}
    metrics={metrics}
    trailing={
     <Text style={styles.target} numberOfLines={1}>
      at {selectionLabel}
     </Text>
    }
   />

   {pendingDelete ? (
    <View style={styles.confirm}>
     <Text style={[styles.buttonText, { flex: 1 }]} numberOfLines={2}>
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
    <>
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
       accessibilityLabel="Set the bookmark here, creating or moving it"
       onPress={onSet}
       disabled={!canName}
       style={[styles.button, styles.buttonPrimary, !canName ? styles.disabled : null]}
      >
       <Text style={styles.buttonTextPrimary}>Set</Text>
      </Pressable>
      <Pressable
       accessibilityRole="button"
       accessibilityLabel="Delete the named bookmark"
       onPress={onDelete}
       disabled={!canName}
       style={[styles.button, !canName ? styles.disabled : null]}
      >
       <Icon name="Trash2" size={13} color={palette.removedCount} />
      </Pressable>
     </View>
     {bookmarks.length > 0 ? (
      <View style={styles.row}>
       {bookmarks.map((bookmark) => (
        <Pressable
         key={bookmark}
         accessibilityRole="button"
         accessibilityLabel={`Use the bookmark ${bookmark}`}
         onPress={() => onBookmarkNameChange(bookmark)}
         style={styles.chip}
        >
         <Text style={styles.chipText} numberOfLines={1}>
          {bookmark}
         </Text>
        </Pressable>
       ))}
      </View>
     ) : null}
    </>
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
