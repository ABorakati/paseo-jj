import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import type { JjActionId } from "../shared/contracts";
import type { DiffPalette } from "./palette";

interface Metrics {
 fontSize: number;
 fontFamily: string;
}

/** One verb in the list. `confirm` marks the verbs that can abandon a revision:
 *  those ask once before running, because the reader cannot see from the row
 *  what will be left behind. The two ids the panel resolves itself — a squash
 *  that needs a destination, and pushing everything tracked — are marked here
 *  so the rest of the list stays exactly the daemon's verbs. */
export type RevisionActionId = JjActionId | "squash-into" | "push-tracked";

export interface RevisionAction {
 id: RevisionActionId;
 label: string;
 hint: string;
 confirm?: string;
}

interface RevisionActionsOverlayProps {
 /** The revision every verb applies to, named the way the trigger names it. */
 selectionLabel: string;
 actions: RevisionAction[];
 onRun(id: string): void;
 onClose(): void;
 busy: boolean;
 /** True when the list holds the verbs for a whole selection: the same list
  *  then reads as one that acts on several revisions, not on one. */
 bulk: boolean;
 palette: DiffPalette;
 metrics: Metrics;
 theme: PluginTheme;
 compact: boolean;
}

/**
 * Every history verb for the selected revision, in one list.
 *
 * They live here rather than as buttons in the sidebar because there are a
 * dozen of them and each one rewrites something: a rail-wide row of unlabeled
 * icons would hide both the verbs and their consequences.
 *
 * With several rows gathered the same list holds the bulk verbs instead, which
 * the panel decides: the overlay only has to say which of the two it is.
 */
export function RevisionActionsOverlay({
 selectionLabel,
 actions,
 onRun,
 onClose,
 busy,
 bulk,
 palette,
 metrics,
 theme,
 compact,
}: RevisionActionsOverlayProps) {
 const [pending, setPending] = useState<RevisionAction | null>(null);

 const styles = useMemo(
  () => ({
   overlay: {
    position: "absolute" as const,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    padding: compact ? 8 : 16,
   },
   scrim: { position: "absolute" as const, top: 0, right: 0, bottom: 0, left: 0 },
   card: {
    alignSelf: "stretch" as const,
    maxHeight: compact ? ("80%" as const) : 460,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: palette.splitDivider,
    borderRadius: 10,
    overflow: "hidden" as const,
   },
   header: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderColor: palette.splitDivider,
   },
   title: { color: palette.filePathMuted, fontSize: metrics.fontSize - 1, fontWeight: "600" as const },
   target: { color: palette.filePath, fontSize: metrics.fontSize, flexShrink: 1 },
   row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
   },
   rowActive: { backgroundColor: theme.colors.surface1 },
   label: { color: palette.filePath, fontSize: metrics.fontSize },
   labelDanger: { color: palette.removedCount, fontSize: metrics.fontSize },
   hint: { color: palette.filePathMuted, fontSize: metrics.fontSize - 1 },
   confirm: {
    padding: 10,
    gap: 8,
    borderBottomWidth: 1,
    borderColor: palette.splitDivider,
    backgroundColor: theme.colors.surface1,
    borderLeftWidth: 3,
    borderLeftColor: palette.removedCount,
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
   buttonText: { color: palette.filePath, fontSize: metrics.fontSize },
   disabled: { opacity: 0.45 },
  }),
  [compact, metrics, palette, theme],
 );

 const renderRow = ({ item }: { item: RevisionAction }) => (
  <Pressable
   accessibilityRole="button"
   // A bulk label already says how many revisions it acts on, so naming the set
   // again would read as "Abandon 2 revisions on 2 revisions".
   accessibilityLabel={bulk ? item.label : `${item.label} on ${selectionLabel}`}
   onPress={() => {
    if (item.confirm) {
     setPending(item);
     return;
    }
    onRun(item.id);
   }}
   disabled={busy}
   style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
    styles.row,
    pressed || hovered ? styles.rowActive : null,
   ]}
  >
   <View style={{ flexShrink: 1 }}>
    <Text style={item.confirm ? styles.labelDanger : styles.label}>{item.label}</Text>
    <Text style={styles.hint} numberOfLines={2}>
     {item.hint}
    </Text>
   </View>
  </Pressable>
 );

 return (
  <View style={styles.overlay}>
   <Pressable
    style={styles.scrim}
    accessibilityRole="button"
    accessibilityLabel="Close the revision actions"
    onPress={onClose}
   />
   <View style={styles.card} testID="jj-revision-actions">
    <View style={styles.header}>
     <Text style={styles.title} numberOfLines={1}>
      {bulk ? "SELECTED" : "REVISION"}
     </Text>
     <Text style={styles.target} numberOfLines={1}>
      {selectionLabel}
     </Text>
    </View>

    {pending ? (
     <View style={styles.confirm}>
      <Text style={styles.label} numberOfLines={3}>
       {pending.confirm}
      </Text>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
       <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Confirm ${pending.label}`}
        onPress={() => onRun(pending.id)}
        disabled={busy}
        style={[styles.button, busy ? styles.disabled : null]}
       >
        <Text style={[styles.buttonText, { color: palette.removedCount }]}>{pending.label}</Text>
       </Pressable>
       <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        onPress={() => setPending(null)}
        style={styles.button}
       >
        <Text style={styles.buttonText}>Cancel</Text>
       </Pressable>
      </View>
     </View>
    ) : null}

    <FlatList
     data={actions}
     testID="jj-action-list"
     keyExtractor={(item: RevisionAction) => item.id}
     renderItem={renderRow}
     initialNumToRender={20}
     ListEmptyComponent={
      <Text style={styles.hint}>This revision has no actions available.</Text>
     }
    />
   </View>
  </View>
 );
}
