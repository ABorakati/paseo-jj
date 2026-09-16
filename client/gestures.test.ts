import assert from "node:assert/strict";
import {
 BLUR,
 NO_MODIFIERS,
 actionTargets,
 bulkRevsets,
 clickedSelection,
 dropCall,
 dropGesture,
 modifiersAfter,
 type HeldModifiers,
} from "./gestures";

/**
 * The gesture table is the panel's contract with jj: every entry here is a
 * command that rewrites history, and a wrong one is not a cosmetic bug. The
 * selection rules decide which revisions a bulk verb is handed.
 */

const held = (extra: Partial<HeldModifiers>): HeldModifiers => ({ ...NO_MODIFIERS, ...extra });

const key = (
 action: "down" | "up",
 pressed: string,
 flags: Partial<Pick<HeldModifiers, "additive" | "shift">> = {},
) => ({
 action,
 key: pressed,
 ctrlKey: flags.additive ?? false,
 metaKey: false,
 shiftKey: flags.shift ?? false,
});

// --- a drop with no modifier moves the branch -------------------------------
{
 assert.equal(dropGesture(NO_MODIFIERS), "rebase-branch");
}

// --- each letter names one verb ---------------------------------------------
{
 assert.equal(dropGesture(held({ r: true })), "rebase-revision");
 assert.equal(dropGesture(held({ s: true })), "squash-into");
 assert.equal(dropGesture(held({ s: true, shift: true })), "squash-onto");
 assert.equal(dropGesture(held({ d: true })), "duplicate-onto");
 assert.equal(dropGesture(held({ m: true })), "merge");
}

// --- two letters at once fall to the narrower verb --------------------------
// Nobody holds two on purpose, but the order has to be defined rather than
// accidental, and the squash pair outranks the single letters.
{
 assert.equal(dropGesture(held({ s: true, r: true })), "squash-into");
 assert.equal(dropGesture(held({ s: true, shift: true, d: true })), "squash-onto");
 assert.equal(dropGesture(held({ m: true, d: true })), "duplicate-onto");
}

// --- ctrl and cmd both mean "add to the selection", and never reach a verb ---
{
 assert.equal(dropGesture(held({ additive: true })), "rebase-branch");
 assert.equal(dropGesture(held({ additive: true, shift: true })), "rebase-branch");
}

// --- every gesture is a verb with the dragged revision and the target -------
{
 assert.deepEqual(dropCall("rebase-branch", "dragged", "target"), {
  action: "rebase",
  revset: "dragged",
  target: "target",
 });
 assert.deepEqual(dropCall("rebase-revision", "dragged", "target"), {
  action: "rebase-revision",
  revset: "dragged",
  target: "target",
 });
 assert.deepEqual(dropCall("squash-into", "dragged", "target"), {
  action: "squash",
  revset: "dragged",
  target: "target",
 });
 assert.deepEqual(dropCall("squash-onto", "dragged", "target"), {
  action: "squash-onto",
  revset: "dragged",
  target: "target",
 });
 assert.deepEqual(dropCall("duplicate-onto", "dragged", "target"), {
  action: "duplicate",
  revset: "dragged",
  target: "target",
 });
 assert.deepEqual(dropCall("merge", "dragged", "target"), {
  action: "merge",
  revset: "dragged",
  target: "target",
 });
}

// --- a plain click is the whole selection, ctrl adds and removes -------------
{
 const one = clickedSelection(new Set<string>(), "a", false);
 assert.deepEqual([...one], ["a"]);

 const two = clickedSelection(one, "b", true);
 assert.deepEqual([...two], ["a", "b"], "the order rows were picked in is kept");

 const three = clickedSelection(two, "c", true);
 assert.deepEqual([...three], ["a", "b", "c"]);

 assert.deepEqual([...clickedSelection(three, "b", true)], ["a", "c"], "ctrl-click takes a row out");

 assert.deepEqual([...clickedSelection(three, "b", false)], ["b"], "a plain click forgets the rest");
}

// --- the selection decides what a verb acts on -------------------------------
{
 assert.deepEqual(actionTargets(new Set(["a", "b"]), "a"), ["a", "b"]);
 assert.deepEqual(actionTargets(new Set(), "a"), ["a"], "an escaped selection falls back to the diff");
 assert.deepEqual(actionTargets(new Set(), null), [], "and with nothing to fall back to, nothing runs");
}

// --- abandon and rebase take the selection as one revset, squash does not ----
{
 assert.deepEqual(bulkRevsets("abandon", ["a", "b", "c"]), ["a | b | c"]);
 assert.deepEqual(bulkRevsets("rebase", ["a", "b"]), ["a | b"]);
 assert.deepEqual(bulkRevsets("squash", ["a", "b"]), ["a", "b"], "one command per revision");
 assert.deepEqual(bulkRevsets("squash", ["a"]), ["a"]);
 assert.deepEqual(bulkRevsets("abandon", []), [], "an empty selection runs nothing");
}

// --- the keyboard tracker ----------------------------------------------------
{
 const pressed = modifiersAfter(NO_MODIFIERS, key("down", "S", { shift: true }));
 assert.deepEqual(pressed, held({ s: true, shift: true }));

 assert.deepEqual(modifiersAfter(pressed, key("up", "S")), NO_MODIFIERS, "releasing a letter clears it");

 const ctrl = modifiersAfter(NO_MODIFIERS, key("down", "a", { additive: true }));
 assert.deepEqual(ctrl, held({ additive: true }), "an unrelated letter still refreshes ctrl");

 assert.deepEqual(
  modifiersAfter(ctrl, key("up", "a")),
  NO_MODIFIERS,
  "and releasing it reports ctrl as up, so a lost keyup cannot stick",
 );

 const cmd = modifiersAfter(NO_MODIFIERS, {
  action: "down",
  key: "Meta",
  ctrlKey: false,
  metaKey: true,
  shiftKey: false,
 });
 assert.deepEqual(cmd, held({ additive: true }), "cmd counts as the additive key too");

 // A chord interrupted by another window: the release never arrives, so only
 // the blur can clear the letters.
 assert.deepEqual(modifiersAfter(pressed, BLUR), NO_MODIFIERS);
}

console.log("gestures.test.ts: all assertions passed");
