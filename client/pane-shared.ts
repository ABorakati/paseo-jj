import { monoFont } from "./diff-view";

export const POLL_MS = 5000;

export function paneMetrics(compact: boolean, platform: Parameters<typeof monoFont>[0]) {
  return { fontSize: compact ? 11 : 12, fontFamily: monoFont(platform) };
}

