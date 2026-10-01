import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * A single jj revision. `changeId` is stable across rewrites; `commitId` is the
 * current snapshot and changes on every rewrite, so the UI keys on `changeId`
 * and treats `commitId` as display data.
 */
export const changeSchema = z.object({
 changeId: z.string(),
 commitId: z.string(),
 author: z.string(),
 /** Relative, e.g. "2 hours ago": a log row reads better with age than with a
  *  wall clock, and the absolute time is still there when it is wanted. */
 age: z.string(),
 timestamp: z.string(),
 committer: z.string(),
 committerTimestamp: z.string(),
 description: z.string(),
 empty: z.boolean(),
 conflicted: z.boolean(),
 bookmarks: z.array(z.string()),
 tags: z.array(z.string()),
 /** True when more than one visible revision carries this change id, which is
  *  the state that makes a change id ambiguous to edit. */
 divergent: z.boolean(),
 /** Change ids of the parents, so a client can lay the revision graph out
  *  without asking jj to draw it. Empty for the root revision. */
 parents: z.array(z.string()),
 /** Immutable revisions are outside the rewrite set, so the panel marks them. */
 immutable: z.boolean(),
});
export type JjChange = z.output<typeof changeSchema>;

/**
 * Syntax roles the tokenizer can emit. A closed set, so the wire contract
 * rejects a role the client has no colour for.
 */
export const tokenRoleSchema = z.enum([
 "keyword",
 "string",
 "comment",
 "number",
 "function",
 "type",
 "builtin",
 "attribute",
 "variable",
 "tag",
 "meta",
 "punctuation",
 "plain",
]);
export type JjTokenRole = z.output<typeof tokenRoleSchema>;

/**
 * A highlighted run of one line. `c` is a syntax role, or null for unstyled
 * text. Field names are short because a large diff carries thousands of these.
 */
export const tokenSchema = z.object({
 t: z.string(),
 c: tokenRoleSchema.nullable(),
});
export type JjToken = z.output<typeof tokenSchema>;

export const diffLineSchema = z.object({
 kind: z.enum(["add", "remove", "context"]),
 oldLine: z.number().nullable(),
 newLine: z.number().nullable(),
 tokens: z.array(tokenSchema),
});
export type JjDiffLine = z.output<typeof diffLineSchema>;

export const diffHunkSchema = z.object({
 header: z.string(),
 oldStart: z.number(),
 newStart: z.number(),
 lines: z.array(diffLineSchema),
});
export type JjDiffHunk = z.output<typeof diffHunkSchema>;

export const fileDiffSchema = z.object({
 path: z.string(),
 previousPath: z.string().nullable(),
 status: z.enum(["added", "modified", "removed", "renamed", "copied"]),
 additions: z.number(),
 deletions: z.number(),
 binary: z.boolean(),
 hunks: z.array(diffHunkSchema),
});
export type JjFileDiff = z.output<typeof fileDiffSchema>;

/** Trimmed to a status letter and path, for the change list without a diff. */
export const fileSummarySchema = z.object({
 path: z.string(),
 status: z.enum(["added", "modified", "removed", "renamed", "copied"]),
});
export type JjFileSummary = z.output<typeof fileSummarySchema>;

export const snapshotRpc = defineRpc({
 name: "jj.snapshot",
 input: z.object({ directory: z.string() }),
 output: z.object({
  /** False when the directory is not inside a jj workspace, which is normal. */
  isRepo: z.boolean(),
  root: z.string().nullable(),
  /** Set when jj exists but the command failed, for example a broken repo. */
  error: z.string().nullable(),
  /** False when the `jj` executable is missing from PATH. */
  jjAvailable: z.boolean(),
  current: changeSchema.nullable(),
  parent: changeSchema.nullable(),
  /** Paths with unresolved conflicts recorded in `@`. */
  conflicts: z.array(z.string()),
  /** Working-copy files changed in `@`, without hunks. */
  files: z.array(fileSummarySchema),
  bookmarks: z.array(z.string()),
  recent: z.array(changeSchema),
  /** Ancestors of `@` plus recent bookmark history, newest first — the branch
   *  structure the panel draws. */
  graph: z.array(changeSchema),
 }),
});

export const diffRpc = defineRpc({
 name: "jj.diff",
 input: z.object({
  directory: z.string(),
  revset: z.string(),
  path: z.string().optional(),
 }),
 output: z.object({
  files: z.array(fileDiffSchema),
  additions: z.number(),
  deletions: z.number(),
  /** True when the diff exceeded the structured-output cap. */
  truncated: z.boolean(),
  error: z.string().nullable(),
 }),
});

/** Every verb the panel can ask jj to run. Shared so the schema and the client
 *  cannot drift: the client's action list is typed by this same union. */
export const ACTION_IDS = [
 "commit",
 "describe",
 "new",
 "undo",
 "redo",
 "abandon",
 "restore",
 "edit",
 "duplicate",
 "squash",
 "squash-hunks",
 "absorb",
 "insert-before",
 "insert-after",
 "bookmark-set",
 "bookmark-advance",
 "bookmark-delete",
 "merge",
 "rebase",
 "push",
 /** Rebase one revision rather than the branch that holds it. The drop that
  *  carries `R` needs jj's `-r`, which the plain rebase cannot ask for. */
 "rebase-revision",
 /** Squash onto a revision instead of into it: jj leaves the source's changes
  *  on top of the destination as a new revision, which `--into` does not do. */
 "squash-onto",
] as const;

export type JjActionId = (typeof ACTION_IDS)[number];

export const actionRpc = defineRpc({
 name: "jj.action",
 input: z.object({
  directory: z.string(),
  action: z.enum(ACTION_IDS),
  message: z.string().optional(),
  revset: z.string().optional(),
  paths: z.array(z.string()).optional(),
  /** Hunks of that one file to move, by their index in the file's diff. Only
   *  `squash-hunks` reads it; jj itself can only move whole paths. */
  hunkIndexes: z.array(z.number().int().nonnegative()).optional(),
  /** Bookmark the bookmark actions act on. */
  name: z.string().optional(),
  /** The other revision: the second parent of a merge, the destination of a
   *  rebase or squash, or the revision a duplicate lands on. */
  target: z.string().optional(),
 }),
 output: z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  /** jj's own output, shown verbatim when a command is only partly expected. */
  output: z.string(),
 }),
});

/**
 * Writing the working copy is the one change the panel makes itself instead of
 * asking jj for: an edit typed into the diff has to land in the file before jj's
 * next snapshot can see it. The path comes from the client, so the server
 * resolves it against the workspace root and refuses anything outside it.
 *
 * `expected` is the file's text as the client read it. When it is given and no
 * longer matches, the write is refused: the panel watches agents edit the same
 * files, and a stale edit must not overwrite what one of them wrote meanwhile.
 */
export const writeFileRpc = defineRpc({
 name: "jj.write-file",
 input: z.object({
  directory: z.string(),
  path: z.string(),
  content: z.string(),
  expected: z.string().optional(),
 }),
 output: z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
 }),
});

/**
 * One file's exact text at a revision, for the file tab. The diff carries only
 * hunks, and rebuilding a file from them loses its final-newline state and stops
 * at the diff's size cap, so the whole file is read from jj instead. `text` is
 * null when there is no text to show, and `reason` says why.
 */
export const readFileRpc = defineRpc({
 name: "jj.read-file",
 input: z.object({
  directory: z.string(),
  revset: z.string(),
  path: z.string(),
 }),
 output: z.object({
  text: z.string().nullable(),
  reason: z.string().nullable(),
 }),
});

