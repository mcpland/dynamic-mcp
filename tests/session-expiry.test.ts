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

  it('touchSession updates existing session timestamp', () => {
    const activity = new Map<string, number>();
    touchSession(activity, 'sess-1', 1000);
    expect(activity.get('sess-1')).toBe(1000);

    touchSession(activity, 'sess-1', 2000);
    expect(activity.get('sess-1')).toBe(2000);
  });

  it('touchSession uses Date.now() when nowMs not provided', () => {
    const activity = new Map<string, number>();
    const before = Date.now();
    touchSession(activity, 'sess-1');
    const after = Date.now();

    const recorded = activity.get('sess-1')!;
    expect(recorded).toBeGreaterThanOrEqual(before);
    expect(recorded).toBeLessThanOrEqual(after);
  });

  it('staleSessionIds returns empty for empty map', () => {
    const activity = new Map<string, number>();
    expect(staleSessionIds(activity, Date.now(), 60_000)).toEqual([]);
  });

  it('staleSessionIds returns all when ttl is 0', () => {
    const activity = new Map<string, number>();
    touchSession(activity, 'a', 1000);
    touchSession(activity, 'b', 2000);

    const stale = staleSessionIds(activity, 3000, 0);
    expect(stale.sort()).toEqual(['a', 'b']);
  });

  it('staleSessionIds returns all when ttl is negative', () => {
    const activity = new Map<string, number>();
    touchSession(activity, 'a', 1000);

    const stale = staleSessionIds(activity, 2000, -100);
    expect(stale).toEqual(['a']);
  });

  it('staleSessionIds returns empty when no sessions are stale', () => {
    const activity = new Map<string, number>();
    touchSession(activity, 'a', 1000);
    touchSession(activity, 'b', 1500);

    const stale = staleSessionIds(activity, 1600, 1000);
    expect(stale).toEqual([]);
  });

  it('staleSessionIds boundary - exactly at ttl is considered stale', () => {
    const activity = new Map<string, number>();
    touchSession(activity, 'a', 1000);

    // Exactly at TTL boundary (nowMs - lastSeenMs >= ttlMs)
    const stale = staleSessionIds(activity, 1600, 600);
    expect(stale).toEqual(['a']);
  });

  it('sessionSweepIntervalMs clamps to minimum of 1000ms', () => {
    expect(sessionSweepIntervalMs(0)).toBe(1000);
    expect(sessionSweepIntervalMs(100)).toBe(1000);
    expect(sessionSweepIntervalMs(2999)).toBe(1000);
  });

  it('sessionSweepIntervalMs clamps to maximum of 30000ms', () => {
    expect(sessionSweepIntervalMs(100_000)).toBe(30_000);
    expect(sessionSweepIntervalMs(1_000_000)).toBe(30_000);
  });

  it('sessionSweepIntervalMs computes ttl / 3 within bounds', () => {
    // 15_000 / 3 = 5000
    expect(sessionSweepIntervalMs(15_000)).toBe(5000);
    // 60_000 / 3 = 20000
    expect(sessionSweepIntervalMs(60_000)).toBe(20_000);
  });
});
