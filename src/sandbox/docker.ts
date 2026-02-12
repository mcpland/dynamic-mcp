import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let checkedAt = 0;
let available = false;

export async function ensureDockerAvailable(dockerBinary: string): Promise<void> {
  const now = Date.now();
  if (now - checkedAt < 30_000) {
    if (!available) {
      throw new Error('Docker is not available.');
    }

    return;
  }

  checkedAt = now;

  try {
    await execFileAsync(dockerBinary, ['info'], {
      timeout: 5_000,
      maxBuffer: 200_000
    });
    available = true;
  } catch {
    available = false;
    throw new Error('Docker is not running or not reachable.');
  }
}

export async function runDocker(
  dockerBinary: string,
  args: string[],
  options?: {
    timeout?: number;
    maxBuffer?: number;
  }
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(dockerBinary, args, {
    timeout: options?.timeout,
    maxBuffer: options?.maxBuffer ?? 1_000_000
  });

  return {
    stdout: stdout ?? '',
    stderr: stderr ?? ''
  };
}
