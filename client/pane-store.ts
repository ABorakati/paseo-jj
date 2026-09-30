import { useSyncExternalStore } from "react";

export interface PaneState {
  revset: string;
  focus: { path: string; nonce: number } | null;
  epoch: number;
}

const initialState: PaneState = { revset: "@", focus: null, epoch: 0 };
const states = new Map<string, PaneState>();
const listeners = new Map<string, Set<() => void>>();
let diffOpener: ((workspaceId: string) => void) | null = null;

export function getPaneState(workspaceId: string): PaneState {
  return states.get(workspaceId) ?? initialState;
}

export function subscribePaneState(workspaceId: string, listener: () => void): () => void {
  let workspaceListeners = listeners.get(workspaceId);
  if (!workspaceListeners) {
    workspaceListeners = new Set();
    listeners.set(workspaceId, workspaceListeners);
  }
  workspaceListeners.add(listener);
  return () => {
    workspaceListeners?.delete(listener);
    if (workspaceListeners?.size === 0) listeners.delete(workspaceId);
  };
}

function update(workspaceId: string, change: (state: PaneState) => PaneState): void {
  const previous = getPaneState(workspaceId);
  const next = change(previous);
  if (next === previous) return;
  states.set(workspaceId, next);
  listeners.get(workspaceId)?.forEach((listener) => listener());
}

export function selectRevision(workspaceId: string, revset: string): void {
  update(workspaceId, (state) => state.revset === revset ? state : { ...state, revset });
}

export function focusFile(workspaceId: string, path: string): void {
  update(workspaceId, (state) => ({
    ...state,
    focus: { path, nonce: (state.focus?.nonce ?? 0) + 1 },
  }));
}

export function bumpEpoch(workspaceId: string): void {
  update(workspaceId, (state) => ({ ...state, epoch: state.epoch + 1 }));
}

export function usePaneState(workspaceId: string): PaneState {
  return useSyncExternalStore(
    (listener) => subscribePaneState(workspaceId, listener),
    () => getPaneState(workspaceId),
    () => initialState,
  );
}

export function setDiffOpener(fn: ((workspaceId: string) => void) | null): void {
  diffOpener = fn;
}

export function openDiffPane(workspaceId: string): void {
  diffOpener?.(workspaceId);
}
