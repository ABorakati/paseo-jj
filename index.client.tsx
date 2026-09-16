import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ChangesPanel } from "./client/changes-panel";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "changes",
    title: "jj changes",
    icon: "GitBranch",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: ChangesPanel,
  });

  client.addCommandCenterItem({
    id: "open-changes",
    title: "Open jj changes",
    icon: "GitBranch",
    keywords: ["jujutsu", "diff", "commit", "changes"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("changes");
    },
  });

  return () => { };
}
