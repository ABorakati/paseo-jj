import assert from "node:assert/strict";
import {
  bumpEpoch,
  focusFile,
  getPaneState,
  openDiffPane,
  selectRevision,
  setDiffOpener,
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
  });
  assert.deepEqual(getPaneState("store-b"), {
    revset: "change-b",
    focus: { path: "src/b.ts", nonce: 1 },
    epoch: 0,
  });
}

{
  let notifications = 0;
  const unsubscribe = subscribePaneState("store-notify", () => { notifications += 1; });
  selectRevision("store-notify", "change-c");
  bumpEpoch("store-notify");
  unsubscribe();
  assert.equal(notifications, 2);
  assert.deepEqual(getPaneState("store-notify"), { revset: "change-c", focus: null, epoch: 1 });
}

{
  let opened: string | null = null;
  setDiffOpener((workspaceId) => { opened = workspaceId; });
  openDiffPane("store-a");
  assert.equal(opened, "store-a");
}

console.log("pane-store.test.ts: all assertions passed");
