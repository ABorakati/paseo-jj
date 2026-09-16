import assert from "node:assert/strict";
import type { JjChange } from "../shared/contracts";
import { buildGraph } from "./revision-graph";

/** The graph is the panel's only structural view of history: a lane that
 *  connects the wrong revisions, or a row that loses its node, misreads the
 *  repository. */

function change(
 changeId: string,
 parents: string[],
 extra: Partial<JjChange> = {},
): JjChange {
 return {
  changeId,
  commitId: changeId,
  author: "agent",
  age: "1 hour ago",
  timestamp: "2026-09-16 10:00",
  committer: "agent",
  committerTimestamp: "2026-09-16 10:00",
  description: changeId,
  empty: false,
  conflicted: false,
  bookmarks: [],
  tags: [],
  divergent: false,
  parents,
  immutable: false,
  ...extra,
 };
}

const gutters = (changes: JjChange[], current: string | null = null) =>
 buildGraph(changes, current).map((row) => row.cells.join(""));

const lanes = (changes: JjChange[], current: string | null = null) =>
 buildGraph(changes, current).map((row) => row.lane);

// --- a straight stack keeps one lane ---------------------------------------
{
 const changes = [change("c", ["b"]), change("b", ["a"]), change("a", [])];
 assert.deepEqual(gutters(changes), ["○ ", "○ ", "○ "]);
 assert.deepEqual(lanes(changes), [0, 0, 0]);
}

// --- a fork and a merge use two lanes --------------------------------------
// The shape jj prints for `new left right`, in jj's own log order.
{
 const changes = [
  change("merge", ["left", "right"]),
  change("other", ["base"]),
  change("right", ["left"]),
  change("left", ["base"]),
  change("base", ["root"]),
  change("root", []),
 ];
 assert.deepEqual(gutters(changes), [
  "○─╮ ",
  "│ │ ○ ",
  "│ ○ │ ",
  "○─╯ │ ",
  "○─╯ ",
  "○ ",
 ]);
 assert.deepEqual(lanes(changes), [0, 2, 1, 0, 0, 0]);
}

// --- a parent outside the list does not leave a dangling lane --------------
{
 const changes = [change("tip", ["gone"]), change("other", [])];
 assert.deepEqual(gutters(changes), ["○ ", "○ "]);
 assert.deepEqual(lanes(changes), [0, 0]);
}

// --- glyphs separate the working copy and immutable history ----------------
{
 const changes = [
  change("work", ["mid"], { empty: true }),
  change("mid", ["main"]),
  change("main", [], { immutable: true }),
 ];
 assert.deepEqual(gutters(changes, "work"), ["@ ", "○ ", "◆ "]);
 assert.deepEqual(gutters(changes, null), ["○ ", "○ ", "◆ "]);
}

// --- a merge whose second parent opens the very first lane -----------------
{
 const changes = [change("m", ["a", "b"]), change("b", ["a"]), change("a", [])];
 assert.deepEqual(gutters(changes), ["○─╮ ", "│ ○ ", "○─╯ "]);
}

console.log("revision-graph.test.ts: all assertions passed");
