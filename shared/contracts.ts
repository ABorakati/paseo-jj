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
 timestamp: z.string(),
 description: z.string(),
 empty: z.boolean(),
 conflicted: z.boolean(),
 bookmarks: z.array(z.string()),
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

export const actionRpc = defineRpc({
 name: "jj.action",
 input: z.object({
  directory: z.string(),
  action: z.enum([
   "commit",
   "describe",
   "new",
   "undo",
   "abandon",
   "restore",
   "bookmark-set",
   "bookmark-delete",
   "merge",
   "rebase",
  ]),
  message: z.string().optional(),
  revset: z.string().optional(),
  paths: z.array(z.string()).optional(),
  /** Bookmark the bookmark actions act on. */
  name: z.string().optional(),
  /** The other revision: the second parent of a merge, or the destination of a
   *  rebase. */
  target: z.string().optional(),
 }),
 output: z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  /** jj's own output, shown verbatim when a command is only partly expected. */
  output: z.string(),
 }),
});
