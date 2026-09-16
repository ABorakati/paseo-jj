import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { actionRpc } from "../shared/contracts";

export interface SquashHunksInput {
 /** The one file the hunks belong to, named the way the diff names it. */
 file: string;
 /** Hunk indexes, in the order that file's diff draws them. */
 hunkIndexes: number[];
 /** Revision the changes come from; the working copy when left out. */
 from?: string;
 /** Revision the hunks land in. */
 into: string;
}

/**
 * Moving part of a file is the one jj verb the panel cannot express as argv:
 * `jj squash -i` wants a diff editor process, and the panel has none. The
 * server therefore computes the destination's new content from the hunks named
 * here and hands it to jj through its diff editor protocol, which keeps the
 * granularity where jj already accepts it — one path, some of its hunks.
 *
 * The caller takes the workspace id the panel was given; the directory comes
 * from the same client state the rest of the panel reads.
 */
export function useSquashHunks(
 workspaceId: string,
): (input: SquashHunksInput) => Promise<void> {
 const workspace = useWorkspace(workspaceId, (snapshot) => ({ directory: snapshot.directory }));
 const callAction = useRpc(actionRpc);
 const queryClient = useQueryClient();
 const directory = workspace?.directory ?? null;

 return useCallback(
  async ({ file, hunkIndexes, from, into }: SquashHunksInput): Promise<void> => {
   if (directory === null) throw new Error("This workspace has no directory yet.");
   const result = await callAction({
    directory,
    action: "squash-hunks",
    revset: from,
    target: into,
    paths: [file],
    hunkIndexes,
   });
   // jj's own words: it refuses an immutable destination and hunks that no
   // longer match with a message the reader can act on, and a message invented
   // here would hide it.
   if (!result.ok) throw new Error(result.error ?? "jj refused to move those hunks.");
   await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["jj", "snapshot"] }),
    queryClient.invalidateQueries({ queryKey: ["jj", "diff"] }),
   ]);
  },
  [callAction, directory, queryClient],
 );
}
