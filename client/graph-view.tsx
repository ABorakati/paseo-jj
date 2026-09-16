import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import type { PointerEvent, ViewStyle } from "react-native";
import type { JjChange } from "../shared/contracts";
import type { DiffPalette } from "./palette";
import { RailHeader } from "./rail-header";
import { buildGraph } from "./revision-graph";

/** One colour per lane, ordered so neighbouring lanes never share one. Kept
 *  apart from the diff palette: these colour structure, not syntax. */
const LANE_COLORS_DARK = ["#7aa2f7", "#9ece6a", "#e0af68", "#bb9af7", "#7dcfff", "#f7768e"];
const LANE_COLORS_LIGHT = ["#2f5fa8", "#3f7a2e", "#8a6410", "#7a4fa3", "#1f6f8b", "#a13b4f"];

const SHORT_ID = 8;

/** Text selection has to stand aside while a row is being dragged: the browser
 *  would otherwise start a native selection under the pointer and take the
 *  gesture with it. Applied only while a drag is live, so a change id can still
 *  be selected and copied off the row. */
const NO_SELECT = { userSelect: "none" } as unknown as ViewStyle;

interface Metrics {
 fontSize: number;
 fontFamily: string;
}

interface GraphViewProps {
 changes: JjChange[];
 /** The revision the diff is reading, resolved to a change id. */
 selectedChangeId: string | null;
 currentChangeId: string | null;
 /** The rows gathered with ctrl-click, which the bulk verbs act on. */
 selection: ReadonlySet<string>;
 /** The row a drag has picked up and the row under the pointer, which is drawn
  *  as where the drop will land. */
 drag: { draggedId: string; targetId: string | null } | null;
 loading: boolean;
 /** Share of the sidebar's height this section claims; 0 while minimized. */
 flex: number;
 minimized: boolean;
 onToggleMinimized(): void;
 onSelect(changeId: string): void;
 /** A press that could become a drag. `bookmark` is set when the press landed
  *  on a bookmark pill rather than on the row itself, because dragging a pill
  *  moves the bookmark and a drag from the row rewrites history instead. */
 onDragStart(changeId: string, bookmark: string | null, pageX: number, pageY: number): void;
 /** The pointer is over this row while a drag is live. */
 onDragOver(changeId: string): void;
 /** Opens the history verbs for the selected revision. */
 onOpenActions(): void;
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
 selection,
 drag,
 loading,
 flex,
 minimized,
 onToggleMinimized,
 onSelect,
 onDragStart,
 onDragOver,
 onOpenActions,
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
   /** Tags read like bookmarks but are not movable, so they are outlined. */
   tag: {
    color: palette.filePathMuted,
    fontSize: metrics.fontSize - 1,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: palette.splitDivider,
    overflow: "hidden" as const,
   },
   conflicted: { color: palette.conflict, fontSize: metrics.fontSize - 1 },
   /** A picked row is one a bulk verb will act on, so it is marked apart from
    *  the row the diff happens to be reading. */
   rowPicked: {
    backgroundColor: theme.colors.surface1,
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.accent,
   },
   /** The row the pointer is over mid-drag: where the drop would land. */
   rowDropTarget: {
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    borderRadius: 4,
   },
   dragged: { opacity: 0.45 },
   headerTrailing: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
   count: { color: theme.colors.accent, fontSize: metrics.fontSize - 1, fontWeight: "600" as const },
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
    ...(change.divergent ? ["divergent"] : []),
   ];
   const picked = selection.has(item.changeId);
   const dragged = drag !== null && drag.draggedId === item.changeId;
   const dropTarget =
    drag !== null && drag.targetId === item.changeId && drag.draggedId !== item.changeId;
   return (
    <Pressable
     accessibilityRole="button"
     accessibilityLabel={`Show ${description || "the change"} (${item.changeId.slice(0, SHORT_ID)})`}
     accessibilityState={{ selected: picked }}
     onPress={() => onSelect(item.changeId)}
     onPointerDown={(event: PointerEvent) =>
      onDragStart(item.changeId, null, event.nativeEvent.pageX, event.nativeEvent.pageY)
     }
     // Both of the pointer handlers are here because a row only learns that it
     // is the drop target by being pointed at, and which of the two fires while
     // a button is held down depends on the host.
     onPointerEnter={() => onDragOver(item.changeId)}
     onPointerMove={() => onDragOver(item.changeId)}
     style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
      styles.row,
      drag === null ? null : NO_SELECT,
      selectedChangeId === item.changeId || pressed || hovered ? styles.rowActive : null,
      picked ? styles.rowPicked : null,
      dragged ? styles.dragged : null,
      dropTarget ? styles.rowDropTarget : null,
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
       // A pill is a drag handle of its own: picked up from here the gesture
       // moves the bookmark, so the press must not be read as the row's.
       <View
        key={bookmark}
        accessibilityLabel={`Move the bookmark ${bookmark}`}
        onPointerDown={(event: PointerEvent) =>
         onDragStart(item.changeId, bookmark, event.nativeEvent.pageX, event.nativeEvent.pageY)
        }
       >
        <Text style={styles.bookmark} numberOfLines={1}>
         {bookmark}
        </Text>
       </View>
      ))}
      {change.tags.map((tag) => (
       <Text key={tag} style={styles.tag} numberOfLines={1}>
        {tag}
       </Text>
      ))}
      {marks.map((mark) => (
       <Text key={mark} style={mark === "empty" ? styles.mark : styles.conflicted}>
        {mark}
       </Text>
      ))}
     </View>
    </Pressable>
   );
  },
  [byId, drag, laneColors, onDragOver, onDragStart, onSelect, selectedChangeId, selection, styles],
 );

 // A minimized section must not carry a flex value: `flex: 0` resolves to a
 // zero basis, which collapses the header to nothing and paints it over the
 // section below.
 const sectionStyle = minimized ? { flexGrow: 0, flexShrink: 0 } : { flex, minHeight: 0 };

 return (
  <View style={sectionStyle}>
   <RailHeader
    label="REVISIONS"
    collapsed={minimized}
    onToggle={onToggleMinimized}
    palette={palette}
    metrics={metrics}
    trailing={
     minimized ? null : (
      <View style={styles.headerTrailing}>
       {/* One picked row is only the row the diff is reading, so the count
           waits until there is a set the bulk verbs would act on. */}
       {selection.size > 1 ? (
        <Text style={styles.count} accessibilityLabel={`${selection.size} revisions selected`}>
         {selection.size} selected
        </Text>
       ) : null}
       <Pressable
        accessibilityRole="button"
        accessibilityLabel="Revision actions"
        onPress={onOpenActions}
        hitSlop={8}
       >
        <Icon name="EllipsisVertical" size={14} color={palette.filePathMuted} />
       </Pressable>
      </View>
     )
    }
   />
   {minimized ? null : (
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
   )}
  </View>
 );
}
