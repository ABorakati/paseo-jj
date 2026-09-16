import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { DiffPalette } from "./palette";

interface Metrics {
 fontSize: number;
 fontFamily: string;
}

interface RailHeaderProps {
 label: string;
 collapsed?: boolean;
 /** Given together with `collapsed`, the label becomes a control that shows and
  *  hides the section below it. */
 onToggle?(): void;
 /** A control on the right edge, such as the tree's collapse-all toggle. */
 trailing?: ReactNode;
 palette: DiffPalette;
 metrics: Metrics;
}

/**
 * Section header for the sidebar. The tree and the graph stack in one column,
 * so their headers have to read as the same kind of thing — and each one owns
 * the open/shut state of its own section.
 */
export function RailHeader({
 label,
 collapsed,
 onToggle,
 trailing,
 palette,
 metrics,
}: RailHeaderProps) {
 const styles = useMemo(
  () => ({
   header: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderColor: palette.splitDivider,
   },
   toggle: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 4,
    flexShrink: 1,
   },
   chevron: {
    width: 12,
    height: 12,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    flexShrink: 0,
    transform: collapsed ? undefined : [{ rotate: "90deg" }],
   },
   text: {
    color: palette.filePathMuted,
    fontSize: metrics.fontSize - 1,
    fontWeight: "600" as const,
    letterSpacing: 0.4,
    flexShrink: 1,
   },
  }),
  [collapsed, metrics.fontSize, palette.filePathMuted, palette.splitDivider],
 );

 const title = (
  <Text style={styles.text} numberOfLines={1}>
   {label}
  </Text>
 );

 return (
  <View style={styles.header}>
   {onToggle ? (
    <Pressable
     accessibilityRole="button"
     accessibilityLabel={`${collapsed ? "Expand" : "Minimize"} ${label.toLowerCase()}`}
     onPress={onToggle}
     hitSlop={6}
     style={styles.toggle}
    >
     <View style={styles.chevron}>
      <Icon name="ChevronRight" size={12} color={palette.filePathMuted} />
     </View>
     {title}
    </Pressable>
   ) : (
    title
   )}
   {trailing}
  </View>
 );
}
