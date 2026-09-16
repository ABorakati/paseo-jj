import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { STATUS_LABEL, statusColor } from "./diff-view";
import type { FileTreeRow } from "./file-tree";
import type { DiffPalette } from "./palette";

/** Indentation per tree level, matching the app's other directory trees. */
const INDENT_PER_LEVEL = 12;
const BASE_INDENT = 8;
const GLYPH = 16;

interface Metrics {
 fontSize: number;
 fontFamily: string;
}

interface CountsProps {
 additions: number;
 deletions: number;
 palette: DiffPalette;
 metrics: Metrics;
}

function Counts({ additions, deletions, palette, metrics }: CountsProps) {
 if (additions === 0 && deletions === 0) return null;
 return (
  <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 }}>
   {additions > 0 ? (
    <Text style={{ color: palette.addedCount, fontSize: metrics.fontSize - 1 }}>
     +{additions}
    </Text>
   ) : null}
   {deletions > 0 ? (
    <Text style={{ color: palette.removedCount, fontSize: metrics.fontSize - 1 }}>
     -{deletions}
    </Text>
   ) : null}
  </View>
 );
}

interface FileTreeRailProps {
 rows: FileTreeRow[];
 collapsed: ReadonlySet<string>;
 selectedPath: string | null;
 allCollapsed: boolean;
 /** True while the diff for the picked revision is still in flight, so an empty
  *  tree reads as loading rather than as a revision with no changes. */
 loading: boolean;
 onToggleFolder(path: string): void;
 onToggleCollapseAll(): void;
 onSelectFile(path: string): void;
 palette: DiffPalette;
 metrics: Metrics;
 theme: PluginTheme;
}

/**
 * The rail beside the diff: one row per directory and file, in the order the
 * diff below lists them. A folder row carries its subtree's totals, so the
 * shape of a change stays readable while the folder is shut.
 */
export function FileTreeRail({
 rows,
 collapsed,
 selectedPath,
 allCollapsed,
 loading,
 onToggleFolder,
 onToggleCollapseAll,
 onSelectFile,
 palette,
 metrics,
 theme,
}: FileTreeRailProps) {
 const styles = useMemo(
  () => ({
   header: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    paddingHorizontal: BASE_INDENT,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderColor: palette.splitDivider,
   },
   headerText: {
    color: palette.filePathMuted,
    fontSize: metrics.fontSize - 1,
    fontWeight: "600" as const,
    letterSpacing: 0.4,
   },
   row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    paddingRight: BASE_INDENT,
    paddingVertical: 3,
   },
   rowActive: { backgroundColor: theme.colors.surface2 },
   chevron: {
    width: GLYPH,
    height: GLYPH,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    flexShrink: 0,
   },
   chevronOpen: { transform: [{ rotate: "90deg" as const }] },
   status: { width: 10, flexShrink: 0, fontWeight: "700" as const },
   label: {
    flexShrink: 1,
    color: palette.filePath,
    fontSize: metrics.fontSize,
    fontFamily: metrics.fontFamily,
   },
   empty: { color: palette.filePathMuted, fontSize: metrics.fontSize, padding: 12 },
  }),
  [palette, metrics, theme],
 );

 const renderRow = useCallback(
  ({ item }: { item: FileTreeRow }) => {
   const paddingLeft = BASE_INDENT + item.depth * INDENT_PER_LEVEL;
   if (item.kind === "folder") {
    const expanded = !collapsed.has(item.path);
    return (
     <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${item.label}`}
      onPress={() => onToggleFolder(item.path)}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
       styles.row,
       { paddingLeft },
       pressed || hovered ? styles.rowActive : null,
      ]}
     >
      <View style={expanded ? [styles.chevron, styles.chevronOpen] : styles.chevron}>
       <Icon name="ChevronRight" size={12} color={palette.filePathMuted} />
      </View>
      <Text style={styles.label} numberOfLines={1}>
       {item.label}
      </Text>
      <View style={{ flex: 1 }} />
      <Counts
       additions={item.additions}
       deletions={item.deletions}
       palette={palette}
       metrics={metrics}
      />
     </Pressable>
    );
   }
   return (
    <Pressable
     accessibilityRole="button"
     accessibilityLabel={`Show ${item.path} in the diff`}
     onPress={() => onSelectFile(item.path)}
     style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
      styles.row,
      { paddingLeft: paddingLeft + GLYPH },
      selectedPath === item.path || pressed || hovered ? styles.rowActive : null,
     ]}
    >
     <Text style={[styles.status, { color: statusColor(item.status, palette) }]}>
      {STATUS_LABEL[item.status]}
     </Text>
     <Text style={styles.label} numberOfLines={1}>
      {item.label}
     </Text>
     <View style={{ flex: 1 }} />
     <Counts
      additions={item.additions}
      deletions={item.deletions}
      palette={palette}
      metrics={metrics}
     />
    </Pressable>
   );
  },
  [collapsed, metrics, onSelectFile, onToggleFolder, palette, selectedPath, styles],
 );

 return (
  <View style={{ flex: 1 }}>
   <View style={styles.header}>
    <Text style={styles.headerText}>CHANGED FILES</Text>
    <Pressable
     accessibilityRole="button"
     accessibilityLabel={allCollapsed ? "Expand every folder" : "Collapse every folder"}
     onPress={onToggleCollapseAll}
     hitSlop={8}
    >
     <Icon
      name={allCollapsed ? "ListChevronsUpDown" : "ListChevronsDownUp"}
      size={14}
      color={palette.filePathMuted}
     />
    </Pressable>
   </View>
   <FlatList
    data={rows}
    testID="jj-file-tree"
    keyExtractor={(item: FileTreeRow) => (item.kind === "folder" ? `d:${item.path}` : item.path)}
    renderItem={renderRow}
    initialNumToRender={40}
    ListEmptyComponent={
     <Text style={styles.empty}>{loading ? "Loading the diff…" : "No changed files."}</Text>
    }
   />
  </View>
 );
}
