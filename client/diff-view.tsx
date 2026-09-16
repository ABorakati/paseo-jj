import type { JjDiffLine, JjFileDiff } from "../shared/contracts";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import type { DiffPalette } from "./palette";

/** React Native has no cross-platform monospace family name. */
export function monoFont(platform: "ios" | "android" | "web"): string {
 if (platform === "ios") return "Menlo";
 if (platform === "android") return "monospace";
 return "ui-monospace, SFMono-Regular, Menlo, monospace";
}

const GUTTER = 38;
const MARKER = 14;
const ACCENT = 3;

interface Metrics {
 fontSize: number;
 fontFamily: string;
}

function Tokens({
 tokens,
 palette,
 metrics,
}: {
 tokens: JjDiffLine["tokens"];
 palette: DiffPalette;
 metrics: Metrics;
}) {
 if (tokens.length === 0) {
  return <Text style={{ color: palette.filePath, fontSize: metrics.fontSize }}> </Text>;
 }
 return (
  <Text
   style={{ color: palette.filePath, fontSize: metrics.fontSize, fontFamily: metrics.fontFamily }}
  >
   {tokens.map((token, index) => {
    const { color, italic } = palette.syntaxFor(token.c);
    return (
     <Text key={index} style={{ color, fontStyle: italic ? "italic" : "normal" }}>
      {token.t}
     </Text>
    );
   })}
  </Text>
 );
}

function Gutter({ value, palette, metrics }: { value: number | null; palette: DiffPalette; metrics: Metrics }) {
 return (
  <Text
   style={{
    width: GUTTER,
    textAlign: "right",
    paddingRight: 8,
    color: palette.lineNumber,
    fontSize: metrics.fontSize,
    fontFamily: metrics.fontFamily,
    opacity: value === null ? 0 : 0.75,
   }}
  >
   {value ?? 0}
  </Text>
 );
}

function backgroundFor(kind: JjDiffLine["kind"], palette: DiffPalette): string {
 if (kind === "add") return palette.addRow;
 if (kind === "remove") return palette.removeRow;
 return palette.contextRow;
}

function accentFor(kind: JjDiffLine["kind"], palette: DiffPalette): string {
 if (kind === "add") return palette.addGutter;
 if (kind === "remove") return palette.removeGutter;
 return "transparent";
}

function markerFor(kind: JjDiffLine["kind"]): string {
 if (kind === "add") return "+";
 if (kind === "remove") return "-";
 return " ";
}

export const UnifiedLine = memo(function UnifiedLine({
 line,
 palette,
 metrics,
}: {
 line: JjDiffLine;
 palette: DiffPalette;
 metrics: Metrics;
}) {
 return (
  <View
   style={{
    flexDirection: "row",
    backgroundColor: backgroundFor(line.kind, palette),
    alignItems: "flex-start",
   }}
  >
   <View
    style={{ width: ACCENT, alignSelf: "stretch", backgroundColor: accentFor(line.kind, palette) }}
   />
   <Gutter value={line.oldLine} palette={palette} metrics={metrics} />
   <Gutter value={line.newLine} palette={palette} metrics={metrics} />
   <Text
    style={{
     width: MARKER,
     color: palette.filePathMuted,
     fontSize: metrics.fontSize,
     fontFamily: metrics.fontFamily,
    }}
   >
    {markerFor(line.kind)}
   </Text>
   <View style={{ flex: 1, paddingRight: 12 }}>
    <Tokens tokens={line.tokens} palette={palette} metrics={metrics} />
   </View>
  </View>
 );
});

function SplitHalf({
 line,
 side,
 palette,
 metrics,
}: {
 line: JjDiffLine | null;
 side: "left" | "right";
 palette: DiffPalette;
 metrics: Metrics;
}) {
 if (!line) {
  return <View style={{ flex: 1, backgroundColor: palette.contextRow, opacity: 0.5 }} />;
 }
 return (
  <View
   style={{
    flex: 1,
    flexDirection: "row",
    backgroundColor: backgroundFor(line.kind, palette),
    alignItems: "flex-start",
   }}
  >
   <View
    style={{ width: ACCENT, alignSelf: "stretch", backgroundColor: accentFor(line.kind, palette) }}
   />
   <Gutter value={side === "left" ? line.oldLine : line.newLine} palette={palette} metrics={metrics} />
   <Text
    style={{
     width: MARKER,
     color: palette.filePathMuted,
     fontSize: metrics.fontSize,
     fontFamily: metrics.fontFamily,
    }}
   >
    {markerFor(line.kind)}
   </Text>
   <View style={{ flex: 1, paddingRight: 8 }}>
    <Tokens tokens={line.tokens} palette={palette} metrics={metrics} />
   </View>
  </View>
 );
}

export const SplitLine = memo(function SplitLine({
 left,
 right,
 palette,
 metrics,
}: {
 left: JjDiffLine | null;
 right: JjDiffLine | null;
 palette: DiffPalette;
 metrics: Metrics;
}) {
 return (
  <View style={{ flexDirection: "row", alignItems: "stretch" }}>
   <SplitHalf line={left} side="left" palette={palette} metrics={metrics} />
   <View style={{ width: 1, backgroundColor: palette.splitDivider }} />
   <SplitHalf line={right} side="right" palette={palette} metrics={metrics} />
  </View>
 );
});

/** Shared with the file tree rail, so a file's letter and colour mean the same
 *  thing in the rail and on its diff header. */
export const STATUS_LABEL: Record<JjFileDiff["status"], string> = {
 added: "A",
 modified: "M",
 removed: "D",
 renamed: "R",
 copied: "C",
};

export function statusColor(status: JjFileDiff["status"], palette: DiffPalette): string {
 if (status === "added") return palette.addedCount;
 if (status === "removed") return palette.removedCount;
 if (status === "renamed" || status === "copied") return palette.conflict;
 return palette.lineNumber;
}

export const FileHeader = memo(function FileHeader({
 file,
 palette,
 metrics,
 compact,
 onRevert,
}: {
 file: JjFileDiff;
 palette: DiffPalette;
 metrics: Metrics;
 compact: boolean;
 onRevert?: () => void;
}) {
 return (
  <View
   style={{
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: palette.contextRow,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: palette.splitDivider,
   }}
  >
   <Text
    style={{
     color: statusColor(file.status, palette),
     fontSize: metrics.fontSize,
     fontWeight: "700",
     width: 14,
    }}
   >
    {STATUS_LABEL[file.status]}
   </Text>
   <Text
    style={{
     color: palette.filePath,
     fontSize: metrics.fontSize,
     flexShrink: 1,
     fontFamily: metrics.fontFamily,
    }}
    numberOfLines={compact ? 1 : 2}
   >
    {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
   </Text>
   <View style={{ flex: 1 }} />
   {file.additions > 0 ? (
    <Text style={{ color: palette.addedCount, fontSize: metrics.fontSize }}>+{file.additions}</Text>
   ) : null}
   {file.deletions > 0 ? (
    <Text style={{ color: palette.removedCount, fontSize: metrics.fontSize }}>-{file.deletions}</Text>
   ) : null}
   {onRevert ? (
    <Pressable
     accessibilityRole="button"
     accessibilityLabel={`Discard changes to ${file.path}`}
     onPress={onRevert}
     hitSlop={8}
    >
     <Icon name="Undo2" size={14} color={palette.filePathMuted} />
    </Pressable>
   ) : null}
  </View>
 );
});

export const HunkHeader = memo(function HunkHeader({
 header,
 palette,
 metrics,
}: {
 header: string;
 palette: DiffPalette;
 metrics: Metrics;
}) {
 return (
  <View style={{ paddingVertical: 4, paddingHorizontal: 12, backgroundColor: palette.contextRow }}>
   <Text
    style={{
     color: palette.filePathMuted,
     fontSize: Math.max(10, metrics.fontSize - 1),
     fontFamily: metrics.fontFamily,
    }}
   >
    {header}
   </Text>
  </View>
 );
});

export const NoteRow = memo(function NoteRow({
 text,
 palette,
 metrics,
}: {
 text: string;
 palette: DiffPalette;
 metrics: Metrics;
}) {
 return (
  <View style={{ paddingVertical: 10, paddingHorizontal: 12, backgroundColor: palette.contextRow }}>
   <Text
    style={{
     color: palette.filePathMuted,
     fontSize: metrics.fontSize,
     fontStyle: "italic",
    }}
   >
    {text}
   </Text>
  </View>
 );
});
