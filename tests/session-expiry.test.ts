import { describe, expect, it } from 'vitest';

import {
  sessionSweepIntervalMs,
  staleSessionIds,
  touchSession
} from '../src/transports/session-expiry.js';

describe('session expiry helpers', () => {
  it('touches and expires sessions by ttl', () => {
    const activity = new Map<string, number>();
    touchSession(activity, 'a', 1000);
    touchSession(activity, 'b', 1500);

    const staleAt2000 = staleSessionIds(activity, 2000, 600);
    expect(staleAt2000.sort()).toEqual(['a']);

    const staleAt2600 = staleSessionIds(activity, 2600, 600);
    expect(staleAt2600.sort()).toEqual(['a', 'b']);
  });

  it('derives bounded sweep intervals', () => {
    expect(sessionSweepIntervalMs(500)).toBe(1000);
    expect(sessionSweepIntervalMs(90_000)).toBe(30_000);
    expect(sessionSweepIntervalMs(9_000)).toBe(3000);
  });
});
