import type { PluginServerContext } from "@getpaseo/plugin/server";
import { action, diff, snapshot } from "./server/changes";
import { actionRpc, diffRpc, snapshotRpc } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  server.handle(snapshotRpc, snapshot);
  server.handle(diffRpc, diff);
  server.handle(actionRpc, action);
  return () => { };
}
