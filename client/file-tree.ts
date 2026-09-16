import type { JjFileDiff } from "../shared/contracts";

/**
 * Directory hierarchy built from the paths a diff reports.
 *
 * The tree is the panel's ordering authority: `orderFiles` hands the diff list
 * the same sequence the rail lists, so the two surfaces never disagree about
 * where a file sits.
 */
export interface FileTreeFolderRow {
 kind: "folder";
 /** Full uncompressed path of the deepest directory this row stands for. */
 path: string;
 /** Compressed label, e.g. "packages/app/src". */
 label: string;
 depth: number;
 additions: number;
 deletions: number;
}

export interface FileTreeFileRow {
 kind: "file";
 /** Repo-relative path, matching the path on the diff's file header. */
 path: string;
 /** Basename, since the rail already shows the directories as folder rows. */
 label: string;
 depth: number;
 additions: number;
 deletions: number;
 status: JjFileDiff["status"];
}

export type FileTreeRow = FileTreeFolderRow | FileTreeFileRow;

export interface FileTree {
 rows: FileTreeRow[];
 /** Every folder path in the compressed tree, for a collapse-all control. */
 folderPaths: string[];
}

interface FileNode {
 kind: "file";
 file: JjFileDiff;
 label: string;
}

interface DirNode {
 kind: "dir";
 /** Full uncompressed path; "" for the virtual root, which is never rendered. */
 path: string;
 /** Compressed label: a merged chain joins its segments, e.g. "packages/app/src". */
 label: string;
 children: TreeNode[];
}

type TreeNode = DirNode | FileNode;

interface DirStats {
 additions: number;
 deletions: number;
}

const EMPTY_STATS: DirStats = { additions: 0, deletions: 0 };

/** Directories before files within a level, then plain ASCII: the order must
 *  not shift with the device locale. */
function compareNodes(a: TreeNode, b: TreeNode): number {
 if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
 if (a.label === b.label) return 0;
 return a.label < b.label ? -1 : 1;
}

function sortTree(node: DirNode): void {
 node.children.sort(compareNodes);
 for (const child of node.children) {
  if (child.kind === "dir") sortTree(child);
 }
}

function buildSortedTree(files: JjFileDiff[]): DirNode {
 const root: DirNode = { kind: "dir", path: "", label: "", children: [] };
 const dirByPath = new Map<string, DirNode>([["", root]]);

 function ensureDir(path: string): DirNode {
  const existing = dirByPath.get(path);
  if (existing) return existing;
  const segments = path.split("/");
  const parent = ensureDir(segments.slice(0, -1).join("/"));
  const label = segments[segments.length - 1] ?? path;
  const node: DirNode = { kind: "dir", path, label, children: [] };
  parent.children.push(node);
  dirByPath.set(path, node);
  return node;
 }

 for (const file of files) {
  const segments = file.path.split("/");
  const label = segments[segments.length - 1] ?? file.path;
  ensureDir(segments.slice(0, -1).join("/")).children.push({ kind: "file", file, label });
 }

 sortTree(root);
 return root;
}

/** Files in tree order, which is the order the diff renders them in. */
export function orderFiles(files: JjFileDiff[]): JjFileDiff[] {
 const ordered: JjFileDiff[] = [];
 const walk = (node: DirNode): void => {
  for (const child of node.children) {
   if (child.kind === "file") ordered.push(child.file);
   else walk(child);
  }
 };
 walk(buildSortedTree(files));
 return ordered;
}

/**
 * Collapse runs of single-child directories into one row, like VS Code: a
 * directory whose only child is another directory absorbs it. The merged row
 * shows the joined segments but keeps the deepest directory's full path as its
 * identity, so collapse state survives the chain splitting later.
 */
function compressNode(node: DirNode): DirNode {
 let label = node.label;
 let path = node.path;
 let children = node.children.map((child) => (child.kind === "dir" ? compressNode(child) : child));
 while (children.length === 1 && children[0].kind === "dir") {
  const only = children[0];
  label = `${label}/${only.label}`;
  path = only.path;
  children = only.children;
 }
 return { kind: "dir", path, label, children };
}

/** The virtual root is never merged, since it is not rendered. */
function compressTree(root: DirNode): DirNode {
 return {
  ...root,
  children: root.children.map((child) => (child.kind === "dir" ? compressNode(child) : child)),
 };
}

/** One post-order pass, so a folder row costs O(subtree) once rather than once
 *  per row. */
function sumStats(root: DirNode): Map<DirNode, DirStats> {
 const statsByNode = new Map<DirNode, DirStats>();
 const visit = (node: DirNode): DirStats => {
  const stats: DirStats = { additions: 0, deletions: 0 };
  for (const child of node.children) {
   if (child.kind === "file") {
    stats.additions += child.file.additions;
    stats.deletions += child.file.deletions;
    continue;
   }
   const childStats = visit(child);
   stats.additions += childStats.additions;
   stats.deletions += childStats.deletions;
  }
  statsByNode.set(node, stats);
  return stats;
 };
 visit(root);
 return statsByNode;
}

/**
 * Build the rows the rail renders. Descendants of a collapsed folder are
 * omitted, and a folder row always carries its whole subtree's totals so the
 * counts stay readable while collapsed.
 */
export function buildFileTree(files: JjFileDiff[], collapsed: ReadonlySet<string>): FileTree {
 const root = compressTree(buildSortedTree(files));
 const statsByNode = sumStats(root);
 const rows: FileTreeRow[] = [];
 const folderPaths: string[] = [];

 const walk = (node: DirNode, depth: number): void => {
  for (const child of node.children) {
   if (child.kind === "file") {
    rows.push({
     kind: "file",
     path: child.file.path,
     label: child.label,
     depth,
     additions: child.file.additions,
     deletions: child.file.deletions,
     status: child.file.status,
    });
    continue;
   }
   const stats = statsByNode.get(child) ?? EMPTY_STATS;
   folderPaths.push(child.path);
   rows.push({
    kind: "folder",
    path: child.path,
    label: child.label,
    depth,
    additions: stats.additions,
    deletions: stats.deletions,
   });
   if (!collapsed.has(child.path)) walk(child, depth + 1);
  }
 };

 walk(root, 0);
 return { rows, folderPaths };
}
