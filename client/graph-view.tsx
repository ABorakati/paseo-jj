import type { PluginTheme } from "@getpaseo/plugin";
import { useCallback, useMemo } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import type { JjChange } from "../shared/contracts";
import type { DiffPalette } from "./palette";
import { buildGraph } from "./revision-graph";

/** One colour per lane, ordered so neighbouring lanes never share one. Kept
 *  apart from the diff palette: these colour structure, not syntax. */
const LANE_COLORS_DARK = ["#7aa2f7", "#9ece6a", "#e0af68", "#bb9af7", "#7dcfff", "#f7768e"];
const LANE_COLORS_LIGHT = ["#2f5fa8", "#3f7a2e", "#8a6410", "#7a4fa3", "#1f6f8b", "#a13b4f"];

const SHORT_ID = 8;

interface Metrics {
 fontSize: number;
 fontFamily: string;
}

interface GraphViewProps {
 changes: JjChange[];
 /** The revision the diff is reading, resolved to a change id. */
 selectedChangeId: string | null;
 currentChangeId: string | null;
 loading: boolean;
 onSelect(changeId: string): void;
 palette: DiffPalette;
 metrics: Metrics;
 theme: PluginTheme;
}

/**
 * The revision graph: one row per revision, jj's lanes drawn in the gutter,
 * bookmarks on the revision they point at. A row is a way to look at a
 * revision's diff, so pressing one picks it and returns to the diff.
 */
export function GraphView({
 changes,
 selectedChangeId,
 currentChangeId,
 loading,
 onSelect,
 palette,
 metrics,
 theme,
}: GraphViewProps) {
 const rows = useMemo(() => buildGraph(changes, currentChangeId), [changes, currentChangeId]);
 const byId = useMemo(() => {
  const map = new Map<string, JjChange>();
  for (const change of changes) map.set(change.changeId, change);
  return map;
 }, [changes]);
 const laneColors = palette.isDark ? LANE_COLORS_DARK : LANE_COLORS_LIGHT;

 const styles = useMemo(
  () => ({
   gutter: {
    color: palette.lineNumber,
    fontSize: metrics.fontSize,
    fontFamily: metrics.fontFamily,
   },
   row: { paddingHorizontal: 10, paddingVertical: 5, gap: 2 },
   rowActive: { backgroundColor: theme.colors.surface2 },
   line: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
   description: { color: palette.filePath, fontSize: metrics.fontSize, flexShrink: 1 },
   empty: { color: palette.filePathMuted, fontSize: metrics.fontSize, fontStyle: "italic" as const },
   changeId: { color: palette.filePathMuted, fontSize: metrics.fontSize - 1, fontFamily: metrics.fontFamily },
   marks: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, paddingLeft: 24 },
   mark: { color: palette.filePathMuted, fontSize: metrics.fontSize - 1 },
   bookmark: {
    color: theme.colors.accentForeground,
    backgroundColor: theme.colors.accent,
    fontSize: metrics.fontSize - 1,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: "hidden" as const,
   },
   conflicted: { color: palette.conflict, fontSize: metrics.fontSize - 1 },
   placeholder: { color: palette.filePathMuted, fontSize: metrics.fontSize, padding: 12 },
  }),
  [metrics, palette, theme],
 );

 const renderRow = useCallback(
  ({ item }: { item: (typeof rows)[number] }) => {
   const change = byId.get(item.changeId);
   if (!change) return null;
   const description = change.description.trim();
   const marks = [
    ...(change.empty ? ["empty"] : []),
    ...(change.conflicted ? ["conflicted"] : []),
   ];
   return (
    <Pressable
     accessibilityRole="button"
     accessibilityLabel={`Show ${description || "the change"} (${item.changeId.slice(0, SHORT_ID)})`}
     onPress={() => onSelect(item.changeId)}
     style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
      styles.row,
      selectedChangeId === item.changeId || pressed || hovered ? styles.rowActive : null,
     ]}
    >
     <View style={styles.line}>
      <Text style={styles.gutter}>
       {item.cells.map((cell, index) => (
        <Text key={index} style={{ color: laneColors[index % laneColors.length] }}>
         {cell}
        </Text>
       ))}
      </Text>
      <Text style={description ? styles.description : styles.empty} numberOfLines={1}>
       {description || "(no description)"}
      </Text>
      <View style={{ flex: 1 }} />
      <Text style={styles.changeId}>{item.changeId.slice(0, SHORT_ID)}</Text>
     </View>
     <View style={styles.marks}>
      {change.bookmarks.map((bookmark) => (
       <Text key={bookmark} style={styles.bookmark} numberOfLines={1}>
        {bookmark}
       </Text>
      ))}
      {marks.map((mark) => (
       <Text key={mark} style={mark === "conflicted" ? styles.conflicted : styles.mark}>
        {mark}
       </Text>
      ))}
     </View>
    </Pressable>
   );
  },
  [byId, laneColors, onSelect, selectedChangeId, styles],
 );

 return (
  <FlatList
   data={rows}
   testID="jj-graph"
   style={{ flex: 1 }}
   keyExtractor={(item: (typeof rows)[number]) => item.changeId}
   renderItem={renderRow}
   initialNumToRender={40}
   ListEmptyComponent={
    <Text style={styles.placeholder}>
     {loading ? "Loading the graph…" : "No revisions to show."}
    </Text>
   }
  />
 );
}
