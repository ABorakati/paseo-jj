import type { JjFileDiff } from "../shared/contracts";
import type { DiffPalette } from "./palette";

/**
 * Typography and file status, which the file tree rail and the revision views
 * share with the diff surface. The diff's own rendering now belongs to Pierre
 * (see `pierre-diff.tsx`), so nothing here draws a diff line.
 */

/** React Native has no cross-platform monospace family name. */
export function monoFont(platform: "ios" | "android" | "web"): string {
 if (platform === "ios") return "Menlo";
 if (platform === "android") return "monospace";
 return "ui-monospace, SFMono-Regular, Menlo, monospace";
}

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
