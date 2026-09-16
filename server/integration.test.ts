import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { action, diff, snapshot } from "./changes";
import { hasJj } from "./jj";

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
