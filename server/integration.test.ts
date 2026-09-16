import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { action, diff, snapshot } from "./changes";
import { hasJj } from "./jj";
import { buildGraph } from "../client/revision-graph";

/**
 * Drives the handlers against a real `jj` binary and a real repository. The
 * unit tests use hand-written diff fixtures, which cannot catch a change in
 * jj's own output format — this can. Run with `npm run test:integration`.
 */
async function main(): Promise<void> {
 if (!(await hasJj())) {
  console.log("integration.test.ts: skipped, no `jj` executable on PATH");
  return;
 }

 const root = mkdtempSync(join(tmpdir(), "paseo-jj-"));
 const jj = (...args: string[]) => execFileSync("jj", args, { cwd: root, encoding: "utf8" });

 try {
  mkdirSync(join(root, "src"), { recursive: true });
  jj("git", "init", "--colocate");
  writeFileSync(join(root, "src/app.ts"), "const port = 3000;\nexport function main() {\n  return port;\n}\n");
  writeFileSync(join(root, "README.md"), "# demo\n");
  jj("describe", "-m", "initial commit");
  jj("new");

  // Working-copy edits: modify one file, add one, delete one.
  writeFileSync(
   join(root, "src/app.ts"),
   'const port = 8080;\nconst host = "127.0.0.1";\nexport function main() {\n  return port;\n}\n',
  );
  writeFileSync(join(root, "src/util.ts"), "export const twice = (n: number) => n * 2;\n");
  rmSync(join(root, "README.md"));

  // --- snapshot on a real repository ------------------------------------
  const snap = await snapshot({ directory: root });
  assert.equal(snap.isRepo, true, "should detect the jj workspace");
  assert.equal(snap.jjAvailable, true);
  assert.ok(snap.root, "root should be reported");
  assert.equal(snap.current?.empty, false, "the working copy has edits");
  assert.equal(snap.current?.description, "", "a fresh change has no description");
  assert.ok(snap.recent.length >= 2, "recent history includes the initial commit");

  assert.deepEqual(
   snap.files.map((file) => `${file.status}:${file.path}`).sort(),
   ["added:src/util.ts", "modified:src/app.ts", "removed:README.md"],
   "the file summary must match the real working copy",
  );

  // --- diff on a real repository ----------------------------------------
  const result = await diff({ directory: root, revset: "@" });
  assert.equal(result.error, null, `diff should not error: ${result.error}`);
  assert.equal(result.truncated, false);
  assert.deepEqual(
   result.files.map((file) => file.path).sort(),
   ["README.md", "src/app.ts", "src/util.ts"],
  );

  const app = result.files.find((file) => file.path === "src/app.ts");
  assert.ok(app, "src/app.ts should appear in the diff");
  assert.equal(app?.status, "modified");
  assert.equal(app?.additions, 2, "two lines added");
  assert.equal(app?.deletions, 1, "one line removed");
  assert.ok(app && app.hunks.length >= 1);

  const rendered = app!.hunks[0].lines.map((line) => line.tokens.map((token) => token.t).join(""));
  assert.ok(rendered.includes("const port = 8080;"), "the edited line round-trips");
  assert.ok(
   app!.hunks[0].lines.some((line) => line.tokens.some((token) => token.c?.includes("keyword"))),
   "TypeScript in a real diff is highlighted",
  );

  assert.equal(result.files.find((file) => file.path === "src/util.ts")?.status, "added");
  assert.equal(result.files.find((file) => file.path === "README.md")?.deletions, 1);

  // --- describe, commit, and the resulting state ------------------------
  const described = await action({ directory: root, action: "describe", message: "rework the port" });
  assert.equal(described.ok, true, described.error ?? "");
  assert.equal((await snapshot({ directory: root })).current?.description, "rework the port");

  const committed = await action({ directory: root, action: "commit", message: "rework the port" });
  assert.equal(committed.ok, true, committed.error ?? "");

  const afterCommit = await snapshot({ directory: root });
  assert.equal(afterCommit.current?.empty, true, "commit leaves a fresh empty working copy");
  assert.equal(afterCommit.parent?.description, "rework the port", "the commit landed on the parent");

  // --- a specific past revision, for history browsing -------------------
  const parentDiff = await diff({ directory: root, revset: "@-" });
  assert.equal(parentDiff.error, null);
  assert.ok(
   parentDiff.files.some((file) => file.path === "src/app.ts"),
   "a past revision can be diffed",
  );

  assert.equal((await action({ directory: root, action: "undo" })).ok, true);

  // --- forks, merges and bookmarks in the graph -------------------------
  // The panel draws its own lanes from this data, so the parent edges, the
  // bookmark placement and the root's empty parent list all have to survive
  // jj's template output.
  const idOf = (revset: string) =>
   jj("log", "--no-graph", "-r", revset, "-T", "change_id").trim();
  const base = idOf("@");
  jj("new", base, "-m", "left branch");
  writeFileSync(join(root, "left.txt"), "left\n");
  const left = idOf("@");
  jj("bookmark", "create", "left-bookmark", "-r", "@");
  jj("new", base, "-m", "right branch");
  writeFileSync(join(root, "right.txt"), "right\n");
  const right = idOf("@");
  jj("new", left, right, "-m", "merge both");
  writeFileSync(join(root, "merged.txt"), "merged\n");
  const merge = idOf("@");

  const graphSnap = await snapshot({ directory: root });
  const node = (id: string) => graphSnap.graph.find((change) => change.changeId === id);
  assert.equal(graphSnap.graph[0]?.changeId, merge, "the graph starts at the working copy");
  assert.deepEqual(
   [...(node(merge)?.parents ?? [])].sort(),
   [left, right].sort(),
   "a merge records both parents",
  );
  assert.ok(node(left)?.bookmarks.includes("left-bookmark"), "a bookmark rides its target revision");
  assert.ok(
   graphSnap.graph.some((change) => change.parents.length === 0),
   "the root's empty parent list parses",
  );

  const rows = buildGraph(graphSnap.graph, graphSnap.current?.changeId ?? null);
  assert.equal(rows[0]?.changeId, merge);
  assert.ok(rows[0]?.cells.join("").includes("╮"), "a merge opens a second lane");
  assert.ok(
   rows.some((row) => row.cells.join("").includes("╯")),
   "the second parent's line converges again",
  );
  assert.equal(
   rows.filter((row) => row.changeId === merge).length,
   1,
   "each revision gets exactly one row",
  );

  // --- bookmark, merge and rebase actions -------------------------------
  // `set` is deliberately the only verb the panel offers: jj creates the
  // bookmark when the name is free and moves it when it is not.
  const created = await action({
   directory: root,
   action: "bookmark-set",
   name: "work",
   revset: merge,
  });
  assert.equal(created.ok, true, created.error ?? "");
  assert.ok(
   (await snapshot({ directory: root })).bookmarks.includes("work"),
   "setting a free name creates the bookmark",
  );

  const moved = await action({
   directory: root,
   action: "bookmark-set",
   name: "work",
   revset: base,
  });
  assert.equal(moved.ok, true, moved.error ?? "");
  const movedSnap = await snapshot({ directory: root });
  assert.ok(
   movedSnap.graph.find((change) => change.changeId === base)?.bookmarks.includes("work"),
   "setting a taken name moves the bookmark to the new revision",
  );
  assert.ok(
   !movedSnap.graph.find((change) => change.changeId === merge)?.bookmarks.includes("work"),
   "and it is no longer on the old revision",
  );

  // A merge of the two branch tips, which is the working copy afterwards.
  const merged = await action({ directory: root, action: "merge", revset: left, target: right });
  assert.equal(merged.ok, true, merged.error ?? "");
  const afterMerge = await snapshot({ directory: root });
  assert.equal(afterMerge.current?.parents.length, 2, "the merge has both revisions as parents");
  assert.deepEqual(
   [...(afterMerge.current?.parents ?? [])].sort(),
   [left, right].sort(),
   "the merge records the revisions it combines",
  );
  assert.deepEqual(afterMerge.conflicts, [], "combining untouched branches conflicts with nothing");

  // Rebasing that merge onto the base moves the branch without losing content.
  const rebased = await action({ directory: root, action: "rebase", revset: merge, target: base });
  assert.equal(rebased.ok, true, rebased.error ?? "");

  const rejected = await action({
   directory: root,
   action: "bookmark-delete",
   name: "--all",
  });
  assert.equal(rejected.ok, false, "a bookmark name that looks like a flag is refused");

  const deleted = await action({ directory: root, action: "bookmark-delete", name: "work" });
  assert.equal(deleted.ok, true, deleted.error ?? "");
  assert.ok(
   !(await snapshot({ directory: root })).bookmarks.includes("work"),
   "the bookmark is gone",
  );

  // --- guards and negative paths ----------------------------------------
  const injected = await action({
   directory: root,
   action: "describe",
   message: "x",
   revset: "--config=ui.color=never",
  });
  assert.equal(injected.ok, false, "a revision that looks like a flag must be refused");

  const emptyMessage = await action({ directory: root, action: "commit", message: "   " });
  assert.equal(emptyMessage.ok, false, "an empty commit message must be refused");

  const notARepo = await snapshot({ directory: tmpdir() });
  assert.equal(notARepo.isRepo, false, "a directory outside a workspace is not a repo");
  assert.equal(notARepo.error, null, "not being a repo is not an error");

  assert.equal((await diff({ directory: tmpdir(), revset: "@" })).error, "Not a jj workspace.");

  console.log("integration.test.ts: all assertions passed");
 } finally {
  rmSync(root, { recursive: true, force: true });
 }
}

main().catch((error: unknown) => {
 console.error(error);
 process.exitCode = 1;
});
