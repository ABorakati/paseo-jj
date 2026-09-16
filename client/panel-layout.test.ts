import assert from "node:assert/strict";
import {
 SIDEBAR_MAX_WIDTH,
 SIDEBAR_MIN_WIDTH,
 SPLIT_MAX,
 SPLIT_MIN,
 draggedSidebarWidth,
 draggedSplitRatio,
} from "./panel-layout";

/** A drag that lands outside the bounds is the one state the panel cannot undo
 *  from the keyboard, so the bounds are asserted rather than trusted. */

// --- the sidebar sits on the right, so leftward drags widen it -------------
{
 assert.equal(draggedSidebarWidth(300, -40), 340, "dragging left widens");
 assert.equal(draggedSidebarWidth(300, 40), 260, "dragging right narrows");
 assert.equal(draggedSidebarWidth(300, 0), 300, "no movement keeps the width");
}

// --- and stops at either end ----------------------------------------------
{
 assert.equal(draggedSidebarWidth(SIDEBAR_MIN_WIDTH + 10, 900), SIDEBAR_MIN_WIDTH);
 assert.equal(draggedSidebarWidth(SIDEBAR_MAX_WIDTH - 10, -900), SIDEBAR_MAX_WIDTH);
 assert.equal(draggedSidebarWidth(300, 10_000), SIDEBAR_MIN_WIDTH, "a runaway drag still lands in range");
}

// --- the section divider converts pixels into a share of the column --------
{
 assert.equal(draggedSplitRatio(0.5, 100, 400), 0.75, "dragging down grows the files section");
 assert.equal(draggedSplitRatio(0.5, -100, 400), 0.25);
 assert.equal(draggedSplitRatio(0.5, 0, 400), 0.5);
 assert.equal(draggedSplitRatio(0.5, 100, 0), 0.5, "an unmeasured column leaves the ratio alone");
}

// --- neither half may be dragged shut -------------------------------------
{
 assert.equal(draggedSplitRatio(0.5, 10_000, 400), SPLIT_MAX);
 assert.equal(draggedSplitRatio(0.5, -10_000, 400), SPLIT_MIN);
}

console.log("panel-layout.test.ts: all assertions passed");
