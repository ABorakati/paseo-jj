import assert from "node:assert/strict";
import {
  bumpEpoch,
  focusFile,
  getPaneState,
  openDiffPane,
  openFile,
  selectRevision,
  setPanelOpener,
  subscribePaneState,
} from "./pane-store";

{
  selectRevision("store-a", "change-a");
  focusFile("store-a", "src/a.ts");
  focusFile("store-a", "src/a.ts");
  selectRevision("store-b", "change-b");
  focusFile("store-b", "src/b.ts");

  assert.deepEqual(getPaneState("store-a"), {
    revset: "change-a",
    focus: { path: "src/a.ts", nonce: 2 },
    epoch: 0,
    file: null,
  });
  assert.deepEqual(getPaneState("store-b"), {
    revset: "change-b",
    focus: { path: "src/b.ts", nonce: 1 },
    epoch: 0,
    file: null,
  });
}

{
  let notifications = 0;
  const unsubscribe = subscribePaneState("store-notify", () => { notifications += 1; });
  selectRevision("store-notify", "change-c");
  bumpEpoch("store-notify");
  unsubscribe();
  assert.equal(notifications, 2);
  assert.deepEqual(getPaneState("store-notify"), {
    revset: "change-c",
    focus: null,
    epoch: 1,
    file: null,
  });
}

{
  const opened: string[] = [];
  setPanelOpener((workspaceId, panelId) => { opened.push(`${workspaceId}:${panelId}`); });
  openDiffPane("store-a");
  openFile("store-file", "src/c.ts", "change-d");
  // The file tab keeps the revision it was opened at when the diff moves on.
  selectRevision("store-file", "change-e");
  assert.deepEqual(opened, ["store-a:diff", "store-file:file"]);
  assert.deepEqual(getPaneState("store-file").file, { path: "src/c.ts", revset: "change-d" });
  setPanelOpener(null);
}

console.log("pane-store.test.ts: all assertions passed");
