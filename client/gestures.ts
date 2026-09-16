import type { JjActionId } from "../shared/contracts";

/**
 * The modifier state a gesture reads. react-native's `PointerEvent` carries no
 * `ctrlKey`/`shiftKey`/`metaKey`, so nothing here comes from the pointer: the
 * panel tracks the keys from the keyboard instead, in `held-keys.ts`.
 */
export interface HeldModifiers {
 /** Ctrl, or Cmd on a Mac: the click adds a row to the selection. */
 additive: boolean;
 shift: boolean;
 r: boolean;
 s: boolean;
 d: boolean;
 m: boolean;
}

export const NO_MODIFIERS: HeldModifiers = {
 additive: false,
 shift: false,
 r: false,
 s: false,
 d: false,
 m: false,
};

/** What the panel's keyboard listener hands the tracker. A real key event is
 *  only read for these five fields, and `blur` — the window losing focus — is
 *  the reset the tracker needs, so it is a state of the same shape. */
export interface KeyState {
 action: "down" | "up" | "blur";
 key: string;
 ctrlKey: boolean;
 metaKey: boolean;
 shiftKey: boolean;
}

/** The window losing focus: whatever it last reported as held is now unknown. */
export const BLUR: KeyState = {
 action: "blur",
 key: "",
 ctrlKey: false,
 metaKey: false,
 shiftKey: false,
};

/** The letters that name a drop action. `R`, `S`, `D` and `M` are jj-view's
 *  own, so a reader who knows one panel knows the other. */
const LETTER_KEYS = ["r", "s", "d", "m"] as const;
type LetterKey = (typeof LETTER_KEYS)[number];

const isLetterKey = (key: string): key is LetterKey =>
 (LETTER_KEYS as readonly string[]).includes(key);

/**
 * The state one key event leaves behind.
 *
 * Every event re-reads ctrl, shift and meta from itself rather than toggling
 * them, so a `keyup` that never arrived is put right by the next event that
 * does. A letter is the exception — nothing in a later event says whether `S`
 * is still down — so a blur wipes the letters too, because one whose release
 * was lost would otherwise stay held for the rest of the session.
 */
export function modifiersAfter(held: HeldModifiers, event: KeyState): HeldModifiers {
 if (event.action === "blur") return NO_MODIFIERS;
 const next: HeldModifiers = {
  ...held,
  additive: event.ctrlKey || event.metaKey,
  shift: event.shiftKey,
 };
 const letter = event.key.toLowerCase();
 if (isLetterKey(letter)) next[letter] = event.action === "down";
 return next;
}

/** What a drop runs. Each name is the verb it ends up as. */
export type DropGesture =
 | "rebase-branch"
 | "rebase-revision"
 | "squash-into"
 | "squash-onto"
 | "duplicate-onto"
 | "merge";

/** The HUD's words for each drop, named as the verb rather than as the key: a
 *  drop is where the reader finds out what the modifier meant. */
export const DROP_LABELS: Record<DropGesture, string> = {
 "rebase-branch": "Rebase branch onto",
 "rebase-revision": "Rebase this revision onto",
 "squash-into": "Squash into",
 "squash-onto": "Squash onto",
 "duplicate-onto": "Duplicate onto",
 merge: "Merge with",
};

/**
 * The gesture the held keys name. Two letters at once is not something anyone
 * does on purpose, so the order below decides and the first match wins;
 * `Shift+S` comes first because it is the narrower squash.
 */
export function dropGesture(held: HeldModifiers): DropGesture {
 if (held.s && held.shift) return "squash-onto";
 if (held.s) return "squash-into";
 if (held.r) return "rebase-revision";
 if (held.d) return "duplicate-onto";
 if (held.m) return "merge";
 return "rebase-branch";
}

/** The daemon call a drop makes. Both revisions travel in the one RPC: the
 *  dragged revision is the source, the row it lands on the target. */
export interface DropCall {
 action: JjActionId;
 revset: string;
 target: string;
}

export function dropCall(gesture: DropGesture, dragged: string, target: string): DropCall {
 switch (gesture) {
  case "rebase-branch":
   return { action: "rebase", revset: dragged, target };
  case "rebase-revision":
   return { action: "rebase-revision", revset: dragged, target };
  case "squash-into":
   return { action: "squash", revset: dragged, target };
  case "squash-onto":
   return { action: "squash-onto", revset: dragged, target };
  case "duplicate-onto":
   return { action: "duplicate", revset: dragged, target };
  case "merge":
   return { action: "merge", revset: dragged, target };
 }
}

/**
 * The selection one click leaves.
 *
 * Ctrl-click adds the row and takes it out again, a plain click makes the row
 * the whole selection. Insertion order is kept because the panel names the
 * selection's revisions in the order they were gathered.
 */
export function clickedSelection(
 selection: ReadonlySet<string>,
 changeId: string,
 additive: boolean,
): ReadonlySet<string> {
 if (!additive) return new Set([changeId]);
 const next = new Set(selection);
 if (next.has(changeId)) next.delete(changeId);
 else next.add(changeId);
 return next;
}

/** The revisions a verb acts on. A plain click leaves its row in the set, so an
 *  empty set only happens after Escape and means the diff's own revision is the
 *  one being pointed at. */
export function actionTargets(
 selection: ReadonlySet<string>,
 fallback: string | null,
): string[] {
 if (selection.size > 0) return [...selection];
 return fallback === null ? [] : [fallback];
}

/** The verbs a selection of rows can run. */
export type BulkVerb = "abandon" | "squash" | "rebase";

/**
 * The revset each command of a bulk verb runs on: one entry per command.
 *
 * jj takes several revisions in one command when they arrive as one revset, and
 * `a | b` is how a union is written — `jj abandon 'a | b'` and
 * `jj rebase -b 'a | b' -d dest` both accept the whole selection at once.
 * Squash does not: `jj squash -r` refuses a revset that resolves to more than
 * one revision, so it comes back as one command per revision, which the panel
 * runs in order and reports one at a time.
 */
export function bulkRevsets(verb: BulkVerb, targets: string[]): string[] {
 if (targets.length === 0) return [];
 if (verb === "squash") return [...targets];
 return [targets.join(" | ")];
}
