import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  // --- the drop gestures' verbs -----------------------------------------
  // A drag asks for two things the plain verbs cannot express: `-r` moves one
  // revision and leaves the rest of its branch behind, where the plain rebase
  // takes the branch along, and `--onto` leaves the source's changes on top of
  // the destination as a new revision where `--into` folds them into it.
  const graft = (name: string, rev: string) => {
   jj("new", rev, "-m", name);
   writeFileSync(join(root, `${name}.txt`), `${name}\n`);
   return idOf("@");
  };
  const parentId = (rev: string) =>
   jj("log", "--no-graph", "-r", `${rev}-`, "-T", "change_id").trim();

  const destination = graft("gesture destination", "root()");
  const branchBase = graft("gesture base", "root()");
  const moves = graft("moves alone", branchBase);
  const follows = graft("follows along", moves);

  const movedAlone = await action({
   directory: root,
   action: "rebase-revision",
   revset: moves,
   target: destination,
  });
  assert.equal(movedAlone.ok, true, movedAlone.error ?? "");
  assert.equal(parentId(moves), destination, "the revision lands on the destination");
  assert.equal(parentId(follows), branchBase, "and the rest of its branch stays behind");

  const source = graft("onto source", branchBase);
  const onto = graft("onto destination", "root()");
  const squashedOnto = await action({
   directory: root,
   action: "squash-onto",
   revset: source,
   target: onto,
  });
  assert.equal(squashedOnto.ok, true, squashedOnto.error ?? "");
  const createdRevision = jj("log", "--no-graph", "-r", `children(${onto})`, "-T", "change_id").trim();
  assert.notEqual(createdRevision, "", "the changes come back as a new revision");
  assert.equal(parentId(createdRevision), onto, "the new revision sits on the destination");
  const createdDiff = await diff({ directory: root, revset: createdRevision });
  assert.ok(
   createdDiff.files.some((file) => file.path === "onto source.txt"),
   "and it carries the dragged changes",
  );

  // --- the bulk plan -----------------------------------------------------
  // The panel passes a selection as one union revset wherever jj accepts one,
  // and runs the verb once per revision where it does not.
  const droppedOne = graft("drop one", destination);
  const droppedTwo = graft("drop two", destination);
  const bulkAbandon = await action({
   directory: root,
   action: "abandon",
   revset: `${droppedOne} | ${droppedTwo}`,
  });
  assert.equal(bulkAbandon.ok, true, bulkAbandon.error ?? "");
  const remaining = jj("log", "--no-graph", "-r", "all()", "-T", "change_id").trim();
  assert.ok(
   !remaining.includes(droppedOne) && !remaining.includes(droppedTwo),
   "one command abandons the whole selection",
  );

  const movedOne = graft("move one", "root()");
  const movedTwo = graft("move two", "root()");
  const bulkRebase = await action({
   directory: root,
   action: "rebase",
   revset: `${movedOne} | ${movedTwo}`,
   target: branchBase,
  });
  assert.equal(bulkRebase.ok, true, bulkRebase.error ?? "");
  assert.equal(parentId(movedOne), branchBase, "the first revision of the union moved in one command");
  assert.equal(parentId(movedTwo), branchBase, "and the second moved with it");

  const squashOne = graft("squash one", branchBase);
  const squashTwo = graft("squash two", squashOne);
  const bulkSquash = await action({
   directory: root,
   action: "squash",
   revset: `${squashOne} | ${squashTwo}`,
  });
  assert.equal(bulkSquash.ok, false, "jj refuses a squash of two revisions at once");
  const oneAtATime = await action({ directory: root, action: "squash", revset: squashTwo });
  assert.equal(oneAtATime.ok, true, oneAtATime.error ?? "");

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

  // --- the history-editing verbs ---------------------------------------
  // Each one rewrites the repo, so they run in an order that keeps the shape
  // predictable: duplicate, insert, squash, edit, absorb, redo.
  const detailSnap = await snapshot({ directory: root });
  const head = detailSnap.current;
  assert.ok(head, "the working copy is reported");
  assert.ok(head!.author.length > 0, "the author's name is parsed");
  assert.ok(head!.committer.length > 0, "the committer's name is parsed");
  assert.ok(head!.age.length > 0, "the relative age is parsed");
  assert.equal(head!.divergent, false, "an ordinary revision is not divergent");
  assert.deepEqual(head!.tags, [], "a repository without tags reports none");

  const duplicated = await action({ directory: root, action: "duplicate", revset: left });
  assert.equal(duplicated.ok, true, duplicated.error ?? "");
  const afterDuplicate = await snapshot({ directory: root });
  assert.ok(
   afterDuplicate.graph.some((change) => change.description === "left branch"),
   "duplicating keeps the source revision",
  );

  const inserted = await action({
   directory: root,
   action: "insert-before",
   revset: left,
   message: "inserted before left",
  });
  assert.equal(inserted.ok, true, inserted.error ?? "");
  assert.equal(
   (await snapshot({ directory: root })).current?.description,
   "inserted before left",
   "the inserted revision is the new working copy",
  );

  const insertedAfter = await action({
   directory: root,
   action: "insert-after",
   revset: left,
   message: "inserted after left",
  });
  assert.equal(insertedAfter.ok, true, insertedAfter.error ?? "");
  assert.equal(
   (await snapshot({ directory: root })).current?.description,
   "inserted after left",
   "insert-after also lands the new working copy",
  );

  const advanced = await action({
   directory: root,
   action: "bookmark-advance",
   name: "left-bookmark",
   revset: merge,
  });
  assert.equal(advanced.ok, true, advanced.error ?? "");
  assert.ok(
   (await snapshot({ directory: root })).graph
    .find((change) => change.changeId === merge)
    ?.bookmarks.includes("left-bookmark"),
   "advancing moves the named bookmark to the target revision",
  );

  // A squash moves the working copy's changes into its parent and abandons the
  // emptied revision, so it is tested with content rather than on an empty
  // revision, where jj has nothing to move and nothing to say.
  writeFileSync(join(root, "squash-me.txt"), "squashed\n");
  const describedForSquash = await action({
   directory: root,
   action: "describe",
   message: "squash me",
  });
  assert.equal(describedForSquash.ok, true, describedForSquash.error ?? "");
  const squashed = await action({ directory: root, action: "squash", revset: "@" });
  assert.equal(squashed.ok, true, squashed.error ?? "");
  const afterSquash = await snapshot({ directory: root });
  assert.ok(
   !afterSquash.graph.some((change) => change.description === "squash me"),
   "squashing into the parent abandons the emptied source",
  );
  const parentAfterSquash = await diff({ directory: root, revset: "@-" });
  assert.ok(
   parentAfterSquash.files.some((file) => file.path === "squash-me.txt"),
   "the squashed content landed in the parent revision",
  );

  const edited = await action({ directory: root, action: "edit", revset: left });
  assert.equal(edited.ok, true, edited.error ?? "");
  assert.equal(
   (await snapshot({ directory: root })).current?.changeId,
   left,
   "edit moves the working copy onto that revision",
  );

  const absorbed = await action({ directory: root, action: "absorb", revset: "@" });
  assert.equal(absorbed.ok, true, absorbed.error ?? "");
  assert.equal(
   (await action({ directory: root, action: "undo" })).ok,
   true,
   "an absorb can be taken back",
  );

  await action({ directory: root, action: "undo" });
  const redone = await action({ directory: root, action: "redo" });
  assert.equal(redone.ok, true, redone.error ?? "");

  // Pushing with no remote and nothing tracked is a no-op that exits 0, so the
  // panel reports jj's own words rather than an error it invented.
  const push = await action({ directory: root, action: "push" });
  assert.equal(push.ok, true, push.error ?? "");
  assert.match(push.output, /Nothing changed/i, `push said: ${push.output}`);

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

  // --- squash by selection ------------------------------------------------
  // A second repository, because these assertions are about the shape of a
  // small history: which file a partial squash moves, and where it lands.
  assert.match(
   process.execPath,
   /node(\.exe)?$/i,
   "the hunk move hands jj a script it runs with this interpreter",
  );
  const picked = mkdtempSync(join(tmpdir(), "paseo-jj-picked-"));
  const pj = (...args: string[]) => execFileSync("jj", args, { cwd: picked, encoding: "utf8" });
  const pickedId = (revset: string) => pj("log", "--no-graph", "-r", revset, "-T", "change_id").trim();
  const litter = () =>
   readdirSync(tmpdir()).filter((name) => name.startsWith("paseo-jj-squash-")).length;
  try {
   pj("git", "init", "--colocate");
   writeFileSync(join(picked, "keep.txt"), "keep\n");
   writeFileSync(join(picked, "move.txt"), "move\n");
   writeFileSync(join(picked, "also.txt"), "also\n");
   pj("commit", "-m", "base");
   // An empty revision keeps the destination one step below the source, so the
   // chosen-ancestor case is not the same move as the parent case.
   pj("describe", "-m", "middle");
   pj("new");
   writeFileSync(join(picked, "keep.txt"), "keep\nkeep two\n");
   writeFileSync(join(picked, "move.txt"), "move\nmove two\n");
   writeFileSync(join(picked, "also.txt"), "also\nalso two\n");
   pj("describe", "-m", "source");
   const baseId = pickedId("@--");
   const middleId = pickedId("@-");
   const sourceId = pickedId("@");

   // An empty selection and a path that looks like a flag are refused before jj
   // is asked anything.
   assert.equal(
    (await action({ directory: picked, action: "squash", revset: sourceId, paths: [] })).ok,
    false,
    "squashing no files is refused",
   );
   assert.equal(
    (await action({
     directory: picked,
     action: "squash",
     revset: sourceId,
     paths: ["--config=ui.color=never"],
    })).ok,
    false,
    "a path that looks like a flag is refused",
   );

   const moved = await action({
    directory: picked,
    action: "squash",
    revset: sourceId,
    target: middleId,
    paths: ["move.txt"],
   });
   assert.equal(moved.ok, true, moved.error ?? "");

   const middleDiff = await diff({ directory: picked, revset: middleId });
   assert.deepEqual(
    middleDiff.files.map((file) => file.path),
    ["move.txt"],
    "only the picked file landed in the parent",
   );
   assert.ok(
    pj("file", "show", "-r", middleId, "--", "move.txt").includes("move two"),
    "the parent's copy holds the moved content",
   );
   const sourceAfterMove = await diff({ directory: picked, revset: sourceId });
   assert.deepEqual(
    sourceAfterMove.files.map((file) => file.path).sort(),
    ["also.txt", "keep.txt"],
    "the file that was not picked stayed in the working copy",
   );

   // The same file, into an ancestor that is not the parent.
   assert.ok(
    !pj("file", "show", "-r", baseId, "--", "keep.txt").includes("keep two"),
    "the ancestor starts without the edit",
   );
   const landed = await action({
    directory: picked,
    action: "squash",
    revset: sourceId,
    target: baseId,
    paths: ["keep.txt"],
   });
   assert.equal(landed.ok, true, landed.error ?? "");
   assert.ok(
    pj("file", "show", "-r", baseId, "--", "keep.txt").includes("keep two"),
    "the file landed in the chosen ancestor",
   );
   const sourceAfterAncestor = await diff({ directory: picked, revset: sourceId });
   assert.deepEqual(
    sourceAfterAncestor.files.map((file) => file.path),
    ["also.txt"],
    "the moved file left the working copy",
   );

   // jj's own words, for a move it will not make.
   const immutable = await action({
    directory: picked,
    action: "squash",
    revset: sourceId,
    target: "root()",
    paths: ["also.txt"],
   });
   assert.equal(immutable.ok, false, "squashing into the root commit is refused");
   assert.match(immutable.error ?? "", /immutable/i, `jj said: ${immutable.error}`);

   // --- one hunk of a file, which jj cannot pick out on its own -----------
   const hunks = (line: number, value: string) =>
    `${Array.from({ length: 40 }, (_, index) => (index + 1 === line ? value : `l${index + 1}`)).join("\n")}\n`;
   pj("commit", "-m", "with also");
   writeFileSync(join(picked, "hunks.txt"), `${Array.from({ length: 40 }, (_, index) => `l${index + 1}`).join("\n")}\n`);
   pj("describe", "-m", "plain");
   pj("new");
   writeFileSync(join(picked, "hunks.txt"), hunks(2, "L2").replace("\nl30\n", "\nL30\n"));
   pj("describe", "-m", "two hunks");
   const plainId = pickedId("@-");
   const hunkSourceId = pickedId("@");
   assert.equal(
    (pj("diff", "-r", hunkSourceId, "--git", "--", "hunks.txt").match(/^@@ /gm) ?? []).length,
    2,
    "the file carries two hunks, so picking one is a real partial move",
   );

   const litterBefore = litter();
   const partial = await action({
    directory: picked,
    action: "squash-hunks",
    revset: hunkSourceId,
    target: plainId,
    paths: ["hunks.txt"],
    hunkIndexes: [0],
   });
   assert.equal(partial.ok, true, partial.error ?? "");
   assert.equal(litter(), litterBefore, "the temp directory jj read is removed");

   const plainFile = pj("file", "show", "-r", plainId, "--", "hunks.txt");
   assert.ok(plainFile.includes("\nL2\n"), "the parent gained the picked hunk");
   assert.ok(!plainFile.includes("L30"), "and gained nothing else");

   const keptHunk = pj("diff", "-r", hunkSourceId, "--git", "--", "hunks.txt");
   assert.ok(keptHunk.includes("+L30"), "the hunk that was not picked stayed in the source");
   assert.ok(!keptHunk.includes("+L2\n"), "the hunk that moved is gone from the source");
   assert.equal(
    (await snapshot({ directory: picked })).graph.find((change) => change.changeId === hunkSourceId)
     ?.description,
    "two hunks",
    "a partial squash leaves the source revision standing",
   );

   const staleHunk = await action({
    directory: picked,
    action: "squash-hunks",
    revset: hunkSourceId,
    target: plainId,
    paths: ["hunks.txt"],
    hunkIndexes: [9],
   });
   assert.equal(staleHunk.ok, false, "a hunk index past the end is refused");
   assert.equal(
    (
     await action({
      directory: picked,
      action: "squash-hunks",
      revset: hunkSourceId,
      target: plainId,
      paths: ["hunks.txt", "also.txt"],
     })
    ).ok,
    false,
    "a hunk move names exactly one file",
   );
  } finally {
   rmSync(picked, { recursive: true, force: true });
  }

  console.log("integration.test.ts: all assertions passed");
 } finally {
  rmSync(root, { recursive: true, force: true });
 }
}

main().catch((error: unknown) => {
 console.error(error);
 process.exitCode = 1;
});
