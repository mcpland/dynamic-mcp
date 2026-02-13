export function touchSession(
  activityMap: Map<string, number>,
  sessionId: string,
  nowMs = Date.now()
): void {
  activityMap.set(sessionId, nowMs);
}

export function staleSessionIds(
  activityMap: Map<string, number>,
  nowMs: number,
  ttlMs: number
): string[] {
  if (ttlMs <= 0) {
    return [...activityMap.keys()];
  }

  const ids: string[] = [];
  for (const [sessionId, lastSeenMs] of activityMap.entries()) {
    if (nowMs - lastSeenMs >= ttlMs) {
      ids.push(sessionId);
    }
  }

  return ids;
}

export function sessionSweepIntervalMs(ttlMs: number): number {
  const derived = Math.floor(ttlMs / 3);
  return Math.min(30_000, Math.max(1_000, derived));
}
