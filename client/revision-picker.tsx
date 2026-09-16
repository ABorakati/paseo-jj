import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import type { NativeSyntheticEvent, TextInputKeyPressEventData } from "react-native";
import { FlatList, Pressable, Text, View } from "react-native";
import type { JjChange } from "../shared/contracts";
import type { DiffPalette } from "./palette";

interface Metrics {
 fontSize: number;
 fontFamily: string;
}

/** One selectable revision. `id` is the revset jj is handed, so a revset typed
 *  into the search box lands in the same shape as the presets. */
export interface RevisionOption {
 id: string;
 /** Primary line: a description, or a bookmark name. */
 label: string;
 /** Secondary line: the short change id, or what kind of entry this is. */
 detail: string;
 /** Trailing marks: bookmarks, and the states worth seeing before clicking. */
 marks: string[];
 /** The option's own lowercase haystack, folded in at build time so filtering
  *  never rebuilds strings while the user types. */
 search: string;
}

interface RevisionSource {
 current: JjChange | null;
 parent: JjChange | null;
 recent: JjChange[];
 bookmarks: string[];
 /** Everything the graph draws, so a revision visible there is also pickable
  *  as a merge parent or rebase destination. */
 graph: JjChange[];
}

const SHORT = 8;

function makeOption(id: string, label: string, detail: string, marks: string[]): RevisionOption {
 return {
  id,
  label,
  detail,
  marks,
  search: `${label} ${detail} ${marks.join(" ")}`.toLowerCase(),
 };
}

/**
 * The presets come first because they are what an agent workflow reaches for:
 * the working copy, its parent, then bookmarks by name. Ancestors follow,
 * newest first, with the current change and the parent left out — `@` and `@-`
 * already cover those, and a duplicate row would only invite the same click
 * twice.
 */
export function buildRevisionOptions({
 current,
 parent,
 recent,
 bookmarks,
 graph,
}: RevisionSource): RevisionOption[] {
 const options: RevisionOption[] = [
  makeOption(
   "@",
   "working copy",
   current ? current.changeId.slice(0, SHORT) : "",
   current && current.empty ? ["empty"] : [],
  ),
  makeOption("@-", "parent", parent ? parent.changeId.slice(0, SHORT) : "", []),
 ];

 const seen = new Set<string>([current?.changeId ?? "", parent?.changeId ?? ""]);
 for (const bookmark of bookmarks) {
  if (seen.has(bookmark)) continue;
  seen.add(bookmark);
  options.push(makeOption(bookmark, bookmark, "bookmark", []));
 }
 // `graph` repeats most of `recent` and adds the revisions beyond it; the `seen`
 // set makes the two lists safe to concatenate.
 for (const change of [...recent, ...graph]) {
  if (seen.has(change.changeId)) continue;
  seen.add(change.changeId);
  const description = change.description.trim().split("\n")[0]?.trim() ?? "";
  options.push(
   makeOption(change.changeId, description || "no description", change.changeId.slice(0, SHORT), [
    ...change.bookmarks,
    ...(change.empty ? ["empty"] : []),
    ...(change.conflicted ? ["conflicted"] : []),
   ]),
  );
 }
 return options;
}

type PickerEntry =
 | { kind: "option"; key: string; option: RevisionOption }
 | { kind: "custom"; key: string; revset: string };

interface RevisionTriggerProps {
 label: string;
 open: boolean;
 onPress(): void;
 palette: DiffPalette;
 theme: PluginTheme;
 metrics: Metrics;
 maxWidth: number;
}

/** The dropdown's closed state: the panel's own button chrome, showing which
 *  revision the diff is reading. */
export function RevisionTrigger({
 label,
 open,
 onPress,
 palette,
 theme,
 metrics,
 maxWidth,
}: RevisionTriggerProps) {
 return (
  <Pressable
   accessibilityRole="button"
   accessibilityLabel={`Choose a revision. Showing ${label}`}
   onPress={onPress}
   style={{
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: open ? theme.colors.surface2 : theme.colors.surface1,
    borderWidth: 1,
    borderColor: open ? theme.colors.accent : palette.splitDivider,
   }}
  >
   <Icon name="GitBranch" size={14} color={palette.filePathMuted} />
   <Text
    style={{ color: palette.filePath, fontSize: metrics.fontSize, flexShrink: 1 }}
    numberOfLines={1}
   >
    {label}
   </Text>
   <View style={open ? { transform: [{ rotate: "180deg" }] } : undefined}>
    <Icon name="ChevronDown" size={14} color={palette.filePathMuted} />
   </View>
  </Pressable>
 );
}

interface RevisionPickerOverlayProps {
 title: string;
 options: RevisionOption[];
 value: string;
 onSelect(revset: string): void;
 onClose(): void;
 palette: DiffPalette;
 theme: PluginTheme;
 metrics: Metrics;
 compact: boolean;
}

/**
 * The open state: a search box over the option list, drawn over the pane.
 *
 * The list filters rather than only scrolls, because a batch of agents leaves
 * dozens of similarly described revisions behind. A query that matches nothing
 * is offered as a revset of its own, so `@--`, `description(fix)` and friends
 * stay reachable without leaving the panel.
 */
export function RevisionPickerOverlay({
 title,
 options,
 value,
 onSelect,
 onClose,
 palette,
 theme,
 metrics,
 compact,
}: RevisionPickerOverlayProps) {
 const [query, setQuery] = useState("");

 const entries = useMemo<PickerEntry[]>(() => {
  const needle = query.trim().toLowerCase();
  const matched = needle ? options.filter((option) => option.search.includes(needle)) : options;
  const list: PickerEntry[] = matched.map((option) => ({
   kind: "option",
   key: option.id,
   option,
  }));
  const typed = query.trim();
  // A leading dash would reach jj as a flag rather than a revision, so it is
  // never offered. The row lands last so Enter prefers a revision the reader
  // can already see; the raw query is the fallback when nothing matches.
  if (typed && !typed.startsWith("-") && !options.some((option) => option.id === typed)) {
   list.push({ kind: "custom", key: `custom:${typed}`, revset: typed });
  }
  return list;
 }, [options, query]);

 const handleKeyPress = (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
  const key = event.nativeEvent.key;
  if (key === "Escape") {
   onClose();
   return;
  }
  if (key !== "Enter") return;
  const first = entries[0];
  if (!first) return;
  onSelect(first.kind === "option" ? first.option.id : first.revset);
 };

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
    maxHeight: compact ? ("70%" as const) : 380,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: palette.splitDivider,
    borderRadius: 10,
    overflow: "hidden" as const,
   },
   search: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderColor: palette.splitDivider,
   },
   title: {
    color: palette.filePathMuted,
    fontSize: metrics.fontSize - 1,
    fontWeight: "600" as const,
    paddingHorizontal: 10,
    paddingTop: 8,
   },
   input: {
    flex: 1,
    color: palette.filePath,
    fontSize: metrics.fontSize + 1,
    paddingVertical: 4,
   },
   row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
   },
   rowActive: { backgroundColor: theme.colors.surface1 },
   check: { width: 14, flexShrink: 0 },
   label: { color: palette.filePath, fontSize: metrics.fontSize, flexShrink: 1 },
   detail: { color: palette.filePathMuted, fontSize: metrics.fontSize - 1, flexShrink: 0 },
   marks: { color: palette.lineNumber, fontSize: metrics.fontSize - 1, flexShrink: 0 },
   empty: { color: palette.filePathMuted, fontSize: metrics.fontSize, padding: 12 },
  }),
  [compact, metrics, palette, theme],
 );

 const renderEntry = ({ item }: { item: PickerEntry }) => {
  if (item.kind === "custom") {
   return (
    <Pressable
     accessibilityRole="button"
     accessibilityLabel={`Use ${item.revset} as a revset`}
     onPress={() => onSelect(item.revset)}
     style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
      styles.row,
      pressed || hovered ? styles.rowActive : null,
     ]}
    >
     <View style={styles.check}>
      <Icon name="CornerDownLeft" size={12} color={palette.filePathMuted} />
     </View>
     <Text style={styles.label} numberOfLines={1}>
      Use "{item.revset}" as a revset
     </Text>
    </Pressable>
   );
  }
  const selected = item.option.id === value;
  return (
   <Pressable
    accessibilityRole="button"
    accessibilityLabel={`Show ${item.option.label}`}
    onPress={() => onSelect(item.option.id)}
    style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
     styles.row,
     selected || pressed || hovered ? styles.rowActive : null,
    ]}
   >
    <View style={styles.check}>
     {selected ? <Icon name="Check" size={12} color={theme.colors.accent} /> : null}
    </View>
    <Text style={styles.label} numberOfLines={1}>
     {item.option.label}
    </Text>
    <View style={{ flex: 1 }} />
    {item.option.marks.length > 0 ? (
     <Text style={styles.marks} numberOfLines={1}>
      {item.option.marks.join(" · ")}
     </Text>
    ) : null}
    <Text style={styles.detail}>{item.option.detail}</Text>
   </Pressable>
  );
 };

 return (
  <View style={styles.overlay}>
   <Pressable
    style={styles.scrim}
    accessibilityRole="button"
    accessibilityLabel="Close the revision picker"
    onPress={onClose}
   />
   <View style={styles.card} testID="jj-revision-picker">
    <Text style={styles.title} numberOfLines={1}>
     {title}
    </Text>
    <View style={styles.search}>
     <Icon name="Search" size={14} color={palette.filePathMuted} />
     <TextInput
      style={styles.input}
      value={query}
      onChangeText={setQuery}
      onKeyPress={handleKeyPress}
      placeholder="Search revisions…"
      placeholderTextColor={palette.filePathMuted}
      autoFocus
      accessibilityLabel="Search revisions"
     />
    </View>
    <FlatList
     data={entries}
     keyExtractor={(item: PickerEntry) => item.key}
     renderItem={renderEntry}
     keyboardShouldPersistTaps="handled"
     initialNumToRender={20}
     ListEmptyComponent={<Text style={styles.empty}>No revision matches.</Text>}
    />
   </View>
  </View>
 );
}
