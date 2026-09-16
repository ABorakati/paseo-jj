import type { JjChange } from "../shared/contracts";

/**
 * Lays the revision graph out as one text row per revision, the way `jj log`
 * draws it but without the connector-only lines between revisions.
 *
 * Each row is a run of two-character cells, one per lane, so a monospace
 * renderer puts the curves under each other. A lane carries the change id it is
 * waiting for; a revision lands in the first lane waiting for it, extra waiters
 * bend into it, and its second parent opens a new lane. Where the two differ,
 * order follows `jj log`: children before parents, newest first.
 */

export interface GraphRow {
 changeId: string;
 /** Lane the revision's own node sits in. */
 lane: number;
 /** One two-character cell per lane, in lane order. */
 cells: string[];
}

/** jj's own glyphs, so the panel's graph reads like the CLI's. */
const WORKING_COPY_GLYPH = "@";
const IMMUTABLE_GLYPH = "◆";
const MUTABLE_GLYPH = "○";

const EMPTY_CELL = "  ";
const PASS_THROUGH_CELL = "│ ";
const DASH_CELL = "──";

export function buildGraph(changes: JjChange[], currentChangeId: string | null): GraphRow[] {
 // A parent outside the list cannot be drawn: the lane would run off the end
 // with nothing to connect to, so those edges are dropped.
 const known = new Set(changes.map((change) => change.changeId));
 const rows: GraphRow[] = [];
 /** Lane i is waiting for revision `lanes[i]`. */
 let lanes: string[] = [];

 for (const change of changes) {
  const expected: number[] = [];
  for (let index = 0; index < lanes.length; index += 1) {
   if (lanes[index] === change.changeId) expected.push(index);
  }

  const opensLane = expected.length === 0;
  const lane = opensLane ? lanes.length : (expected[0] as number);
  const merging = expected.slice(1);
  const parents = change.parents.filter((parent) => known.has(parent));
  const extraParents = parents.slice(1);
  // Lanes as this row draws them: the ones carried over, the node's own lane if
  // it is new, then one lane per extra parent.
  const carried = opensLane ? lanes.length + 1 : lanes.length;
  const extraLanes = extraParents.map((_, index) => carried + index);
  const width = carried + extraParents.length;

  const cells: string[] = new Array(width).fill(EMPTY_CELL);
  for (let index = 0; index < carried; index += 1) {
   if (index !== lane) cells[index] = PASS_THROUGH_CELL;
  }
  // `expected` is built in lane order, so the node always takes the leftmost
  // lane waiting for it and every other waiter — and every extra parent —
  // sits to its right.
  for (const index of merging) cells[index] = "╯ ";
  for (const index of extraLanes) cells[index] = "╮ ";

  const rightTargets = [...merging, ...extraLanes];
  cells[lane] = `${glyphFor(change, currentChangeId)}${rightTargets.length > 0 ? "─" : " "}`;
  if (rightTargets.length > 0) {
   const nearest = Math.min(...rightTargets);
   for (let index = lane + 1; index < nearest; index += 1) cells[index] = DASH_CELL;
  }

  rows.push({ changeId: change.changeId, lane, cells });

  const next: string[] = [];
  for (let index = 0; index < carried; index += 1) {
   if (merging.includes(index)) continue;
   if (index === lane) {
    const first = parents[0];
    if (first !== undefined) next.push(first);
    continue;
   }
   const carriedOver = lanes[index];
   if (carriedOver !== undefined) next.push(carriedOver);
  }
  next.push(...extraParents);
  lanes = next;
 }

 return rows;
}

function glyphFor(change: JjChange, currentChangeId: string | null): string {
 if (change.changeId === currentChangeId) return WORKING_COPY_GLYPH;
 return change.immutable ? IMMUTABLE_GLYPH : MUTABLE_GLYPH;
}
