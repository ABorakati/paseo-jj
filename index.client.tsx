import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ChangesPanel } from "./client/changes-panel";
import { DiffPane } from "./client/diff-pane";
import { setDiffOpener } from "./client/pane-store";

export default function contribute(client: PluginClientContext) {
  const removeChanges = client.addWorkspacePanel({
    id: "changes",
    title: "jj changes",
    icon: "GitBranch",
    context: "workspace",
    locations: ["explorer"],
    Component: ChangesPanel,
  });
  const removeDiff = client.addWorkspacePanel({
    id: "diff",
    title: "jj diff",
    icon: "FileDiff",
    context: "workspace",
    locations: ["workspace"],
    Component: DiffPane,
  });
  const removeOpenChanges = client.addCommandCenterItem({
    id: "open-changes",
    title: "Open jj changes",
    icon: "GitBranch",
    keywords: ["jujutsu", "diff", "commit", "changes"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("changes", { location: "explorer" });
    },
  });
  const removeOpenDiff = client.addCommandCenterItem({
    id: "open-diff",
    title: "Open jj diff",
    icon: "FileDiff",
    keywords: ["jujutsu", "diff", "files"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("diff", { location: "workspace" });
    },
  });
  setDiffOpener((workspaceId) => {
    client.openPanel("diff", { workspaceId, location: "workspace" });
  });
  return () => {
    removeChanges();
    removeDiff();
    removeOpenChanges();
    removeOpenDiff();
    setDiffOpener(null);
  };
}
