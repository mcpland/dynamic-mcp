import { runDocker } from './docker.js';

export interface SandboxSessionRecord {
  id: string;
  image: string;
  createdAt: string;
  lastUsedAt: string;
}

export class SandboxSessionRegistry {
  private readonly sessions = new Map<string, SandboxSessionRecord>();

  add(session: SandboxSessionRecord, maxSessions: number): void {
    if (this.sessions.size >= maxSessions) {
      throw new Error(`Sandbox session limit reached (${maxSessions}).`);
    }

    this.sessions.set(session.id, session);
  }

  get(id: string): SandboxSessionRecord | null {
    const session = this.sessions.get(id);
    return session ? structuredClone(session) : null;
  }

  touch(id: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }

    session.lastUsedAt = new Date().toISOString();
  }

  remove(id: string): boolean {
    return this.sessions.delete(id);
  }

  list(): SandboxSessionRecord[] {
    return [...this.sessions.values()]
      .map((session) => structuredClone(session))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async cleanupIdleSessions(options: {
    dockerBinary: string;
    timeoutMs: number;
  }): Promise<number> {
    const now = Date.now();
    const staleIds = this.list()
      .filter((session) => {
        const last = Date.parse(session.lastUsedAt);
        return Number.isFinite(last) && now - last > options.timeoutMs;
      })
      .map((session) => session.id);

    for (const id of staleIds) {
      await forceRemoveContainer(options.dockerBinary, id);
      this.remove(id);
    }

    return staleIds.length;
  }

  async cleanupAll(dockerBinary: string): Promise<void> {
    const ids = this.list().map((session) => session.id);
    for (const id of ids) {
      await forceRemoveContainer(dockerBinary, id);
      this.remove(id);
    }
  }
}

async function forceRemoveContainer(dockerBinary: string, id: string): Promise<void> {
  try {
    await runDocker(dockerBinary, ['rm', '-f', id], { timeout: 10_000 });
  } catch {
    // Best effort cleanup.
  }
}
