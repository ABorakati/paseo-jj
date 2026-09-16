import type { PluginTheme } from "@getpaseo/plugin";
import type { JjTokenRole } from "../shared/contracts";

type Rgb = { r: number; g: number; b: number };

/** Accepts `#rgb`, `#rrggbb`, and `#rrggbbaa`. Returns null for anything else,
 *  including the `rgb()` strings the blends below produce. */
export function parseHex(color: string): Rgb | null {
 const value = color.trim();
 if (!value.startsWith("#")) return null;
 const hex = value.slice(1);
 const expand = (part: string) =>
  part.length === 1 ? Number.parseInt(part + part, 16) : Number.parseInt(part, 16);
 if (hex.length === 3 || hex.length === 4) {
  const [r, g, b] = [hex[0], hex[1], hex[2]].map(expand);
  if ([r, g, b].some(Number.isNaN)) return null;
  return { r, g, b };
 }
 if (hex.length === 6 || hex.length === 8) {
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return null;
  return { r, g, b };
 }
 return null;
}

/** Relative luminance, used only to decide light or dark. */
export function luminance(color: string): number {
 const rgb = parseHex(color);
 if (!rgb) return 1;
 return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

export function withAlpha(color: string, alpha: number): string {
 const rgb = parseHex(color);
 if (!rgb) return color;
 return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/**
 * Blend `over` onto `under` at `alpha`. Diff tints stay opaque: a translucent
 * row shows the previous row through it wherever a line wraps.
 */
export function blend(under: string, over: string, alpha: number): string {
 const underRgb = parseHex(under);
 const overRgb = parseHex(over);
 if (!underRgb || !overRgb) return under;
 const mix = (x: number, y: number) => Math.round(x * (1 - alpha) + y * alpha);
 return `rgb(${mix(underRgb.r, overRgb.r)}, ${mix(underRgb.g, overRgb.g)}, ${mix(underRgb.b, overRgb.b)})`;
}

/**
 * Syntax colours are conventional rather than derived from the host accent: a
 * six-token theme cannot supply thirteen distinguishable code colours, and
 * forcing them from the accent makes code unreadable. The palette is chosen by
 * the surface's luminance so it stays legible in light and dark themes.
 */
const DARK_SYNTAX: Record<JjTokenRole, string> = {
 keyword: "#c678dd",
 string: "#98c379",
 comment: "#7d8590",
 number: "#d19a66",
 function: "#61afef",
 type: "#e5c07b",
 builtin: "#56b6c2",
 attribute: "#e06c75",
 variable: "#e06c75",
 tag: "#e06c75",
 meta: "#7d8590",
 punctuation: "#9aa4b2",
 plain: "#d4d4d4",
};

const LIGHT_SYNTAX: Record<JjTokenRole, string> = {
 keyword: "#cf222e",
 string: "#0a3069",
 comment: "#6e7781",
 number: "#0550ae",
 function: "#8250df",
 type: "#953800",
 builtin: "#0550ae",
 attribute: "#953800",
 variable: "#953800",
 tag: "#116329",
 meta: "#6e7781",
 punctuation: "#57606a",
 plain: "#1f2328",
};

export interface DiffPalette {
 isDark: boolean;
 addRow: string;
 removeRow: string;
 addGutter: string;
 removeGutter: string;
 contextRow: string;
 /** Split view draws a vertical rule between its two columns. */
 splitDivider: string;
 lineNumber: string;
 filePath: string;
 filePathMuted: string;
 addedCount: string;
 removedCount: string;
 conflict: string;
 syntaxFor(role: JjTokenRole | null): { color: string; italic: boolean };
}

export function buildPalette(theme: PluginTheme): DiffPalette {
 const colors = theme.colors;
 const isDark = luminance(colors.surface0) < 0.5;
 const syntax = isDark ? DARK_SYNTAX : LIGHT_SYNTAX;
 const tint = isDark ? 0.18 : 0.22;

 return {
  isDark,
  addRow: blend(colors.surface0, colors.statusSuccess, tint),
  removeRow: blend(colors.surface0, colors.statusDanger, tint),
  addGutter: withAlpha(colors.statusSuccess, isDark ? 0.9 : 1),
  removeGutter: withAlpha(colors.statusDanger, isDark ? 0.9 : 1),
  contextRow: colors.surface0,
  splitDivider: colors.border,
  lineNumber: colors.foregroundMuted,
  filePath: colors.foreground,
  filePathMuted: colors.foregroundMuted,
  addedCount: colors.statusSuccess,
  removedCount: colors.statusDanger,
  conflict: colors.statusWarning,
  syntaxFor(role: JjTokenRole | null) {
   // Unstyled text keeps the host foreground so diff content always meets
   // the theme's contrast rather than a palette default.
   if (role === null || role === "plain") return { color: colors.foreground, italic: false };
   return { color: syntax[role], italic: role === "comment" };
  },
 };
}
