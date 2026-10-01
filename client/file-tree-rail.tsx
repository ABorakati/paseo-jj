import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import type { PressableProps } from "react-native";
import { STATUS_LABEL, statusColor } from "./diff-view";
import type { FileTreeRow } from "./file-tree";
import type { DiffPalette } from "./palette";
import { RailHeader } from "./rail-header";

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
 /** Paths picked for a move into another revision. */
 checked: ReadonlySet<string>;
 /** True when every changed file is picked, so the box reads as a single
  *  select-all that can also clear the selection. */
 allChecked: boolean;
 /** True while a move is in flight, which the row's button waits on. */
 busy: boolean;
 onToggleChecked(path: string): void;
 onToggleCheckAll(): void;
 onSquashChecked(): void;
 allCollapsed: boolean;
 /** True while the diff for the picked revision is still in flight, so an empty
  *  tree reads as loading rather than as a revision with no changes. */
 loading: boolean;
 /** Share of the sidebar's height this section claims; 0 while minimized. */
 flex: number;
 minimized: boolean;
 onToggleMinimized(): void;
 onToggleFolder(path: string): void;
 onToggleCollapseAll(): void;
 onSelectFile(path: string): void;
 /** Opens the whole file in the file tab. */
 onOpenFile(path: string): void;
 palette: DiffPalette;
 metrics: Metrics;
 theme: PluginTheme;
}

/**
 * A pick box is a checkbox to assistive tech, and the state is what it has to
 * read. react-native-web forwards `accessibilityRole` but drops
 * `accessibilityState`, so the aria attribute is passed directly — a native
 * build never sees the unknown key.
 */
const ariaChecked = (checked: boolean) => ({ "aria-checked": checked }) as unknown as PressableProps;

/**
 * The pick box. It is drawn rather than taken from the icon set: it is the
 * control the whole move hangs on, so it must not depend on an icon name the
 * host may not carry.
 */
function CheckBox({ checked, theme }: { checked: boolean; theme: PluginTheme }) {
 return (
  <View
   style={{
    width: 13,
    height: 13,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: checked ? theme.colors.accent : theme.colors.border,
    backgroundColor: checked ? theme.colors.accent : "transparent",
    alignItems: "center",
    justifyContent: "center",
   }}
  >
   {checked ? (
    <Text style={{ color: theme.colors.accentForeground, fontSize: 10, lineHeight: 11 }}>✓</Text>
   ) : null}
  </View>
 );
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
 checked,
 allChecked,
 busy,
 onToggleChecked,
 onToggleCheckAll,
 onSquashChecked,
 allCollapsed,
 loading,
 flex,
 minimized,
 onToggleMinimized,
 onToggleFolder,
 onToggleCollapseAll,
 onSelectFile,
 onOpenFile,
 palette,
 metrics,
 theme,
}: FileTreeRailProps) {
 const styles = useMemo(
  () => ({
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
   /** The click target for picking a file, kept out of the row's own press so
    *  the two never answer the same click. */
   check: {
    width: 16,
    height: 16,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    flexShrink: 0,
   },
   hit: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    flex: 1,
    minWidth: 0,
   },
   selectBar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    paddingHorizontal: BASE_INDENT,
    paddingVertical: 5,
   },
   count: { color: palette.filePathMuted, fontSize: metrics.fontSize - 1 },
   move: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: palette.splitDivider,
    backgroundColor: theme.colors.surface1,
   },
   moveText: { color: palette.filePath, fontSize: metrics.fontSize - 1 },
   idle: { opacity: 0.45 },
   open: {
    width: 20,
    height: 20,
    borderRadius: 4,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    flexShrink: 0,
   },
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
    <View style={[styles.row, { paddingLeft: paddingLeft + GLYPH }]}>
     <Pressable
      {...ariaChecked(checked.has(item.path))}
      accessibilityRole="checkbox"
      accessibilityLabel={`${checked.has(item.path) ? "Deselect" : "Select"} ${item.path}`}
      accessibilityState={{ checked: checked.has(item.path) }}
      onPress={() => onToggleChecked(item.path)}
      hitSlop={6}
      style={styles.check}
     >
      <CheckBox checked={checked.has(item.path)} theme={theme} />
     </Pressable>
     <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Show ${item.path} in the diff`}
      onPress={() => onSelectFile(item.path)}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
       styles.hit,
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
     {/* A removed file has nothing left at this revision to open. */}
     {item.status === "removed" ? (
      <View style={styles.open} />
     ) : (
      <Pressable
       accessibilityRole="button"
       accessibilityLabel={`Open ${item.path} in the file tab`}
       onPress={() => onOpenFile(item.path)}
       hitSlop={6}
       style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.open,
        hovered ? styles.rowActive : null,
       ]}
      >
       <Icon name="FileCode" size={13} color={palette.filePathMuted} />
      </Pressable>
     )}
    </View>
   );
  },
  [
   checked,
   collapsed,
   metrics,
   onOpenFile,
   onSelectFile,
   onToggleChecked,
   onToggleFolder,
   palette,
   selectedPath,
   styles,
   theme,
  ],
 );

 // A minimized section must not carry a flex value: `flex: 0` resolves to a
 // zero basis, which collapses the header to nothing and paints it over the
 // section below.
 const sectionStyle = minimized ? { flexGrow: 0, flexShrink: 0 } : { flex, minHeight: 0 };

 return (
  <View style={sectionStyle}>
   <RailHeader
    label="CHANGED FILES"
    collapsed={minimized}
    onToggle={onToggleMinimized}
    palette={palette}
    metrics={metrics}
    trailing={
     minimized ? null : (
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
     )
    }
   />
   {minimized ? null : (
    <View style={styles.selectBar}>
     <Pressable
      {...ariaChecked(allChecked)}
      accessibilityRole="checkbox"
      accessibilityLabel={allChecked ? "Clear the file selection" : "Select every changed file"}
      accessibilityState={{ checked: allChecked }}
      onPress={onToggleCheckAll}
      hitSlop={6}
      style={styles.check}
     >
      <CheckBox checked={allChecked} theme={theme} />
     </Pressable>
     <Text style={styles.count}>{checked.size} selected</Text>
     <View style={{ flex: 1 }} />
     <Pressable
      accessibilityRole="button"
      accessibilityLabel="Move the selected files into another revision"
      onPress={onSquashChecked}
      disabled={checked.size === 0 || busy}
      style={[styles.move, checked.size === 0 || busy ? styles.idle : null]}
     >
      <Text style={styles.moveText}>Squash…</Text>
     </Pressable>
    </View>
   )}
   {minimized ? null : (
    <FlatList
     data={rows}
     testID="jj-file-tree"
     style={{ flex: 1 }}
     keyExtractor={(item: FileTreeRow) => (item.kind === "folder" ? `d:${item.path}` : item.path)}
     renderItem={renderRow}
     initialNumToRender={40}
     ListEmptyComponent={
      <Text style={styles.empty}>{loading ? "Loading the diff…" : "No changed files."}</Text>
     }
    />
   )}
  </View>
 );
}
