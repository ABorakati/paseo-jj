import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ChangesPanel } from "./client/changes-panel";
import { DiffPane } from "./client/diff-pane";
import { FilePane } from "./client/file-pane";
import { setPanelOpener } from "./client/pane-store";

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
  const removeFile = client.addWorkspacePanel({
    id: "file",
    title: "jj file",
    icon: "FileCode",
    context: "workspace",
    locations: ["workspace"],
    Component: FilePane,
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
  setPanelOpener((workspaceId, panelId) => {
    client.openPanel(panelId, { workspaceId, location: "workspace" });
  });
  return () => {
    removeChanges();
    removeDiff();
    removeFile();
    removeOpenChanges();
    removeOpenDiff();
    setPanelOpener(null);
  };
}
