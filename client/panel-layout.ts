/**
 * Geometry for the sidebar. Drag deltas arrive in pixels and land in state, so
 * the bounds live here: a pane dragged to nothing, or past the width of the
 * window, is a state the panel can never recover from by itself.
 */

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 620;
export const SIDEBAR_INITIAL_WIDTH = 240;

/** Share of the sidebar the files section claims when both sections are open.
 *  Neither half can be dragged shut, which keeps both headers reachable. */
export const SPLIT_MIN = 0.15;
export const SPLIT_MAX = 0.85;
export const SPLIT_INITIAL = 0.5;

/**
 * The sidebar sits on the right edge, so dragging left (`deltaX` negative)
 * widens it.
 */
export function draggedSidebarWidth(startWidth: number, deltaX: number): number {
 const width = startWidth - deltaX;
 return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

/**
 * Drag on the divider between the two sections. The ratio needs a measured
 * height to convert pixels into a share; before the first layout pass there is
 * none, so the ratio is left alone rather than guessed.
 */
export function draggedSplitRatio(startRatio: number, deltaY: number, sidebarHeight: number): number {
 if (sidebarHeight <= 0) {
  return startRatio;
 }
 const ratio = startRatio + deltaY / sidebarHeight;
 return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio));
}
