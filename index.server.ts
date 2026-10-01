import type { PluginServerContext } from "@getpaseo/plugin/server";
import { action, diff, readFile, snapshot, writeFile } from "./server/changes";
import { actionRpc, diffRpc, readFileRpc, snapshotRpc, writeFileRpc } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
 server.handle(snapshotRpc, snapshot);
 server.handle(diffRpc, diff);
 server.handle(actionRpc, action);
 server.handle(writeFileRpc, writeFile);
 server.handle(readFileRpc, readFile);
 return () => { };
}
