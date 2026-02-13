import { describe, expect, it } from 'vitest';

import {
  sanitizeContainerId,
  sanitizeDockerImage,
  sanitizeShellCommand
} from '../src/sandbox/policy.js';

describe('sanitizeContainerId', () => {
  it('accepts valid alphanumeric container IDs', () => {
    expect(sanitizeContainerId('abc123')).toBe('abc123');
    expect(sanitizeContainerId('mcp-sbx-abcdef')).toBe('mcp-sbx-abcdef');
    expect(sanitizeContainerId('my_container.name-1')).toBe('my_container.name-1');
  });

  it('accepts single character container ID', () => {
    expect(sanitizeContainerId('a')).toBe('a');
    expect(sanitizeContainerId('1')).toBe('1');
  });

  it('rejects container IDs starting with special characters', () => {
    expect(sanitizeContainerId('.invalid')).toBeNull();
    expect(sanitizeContainerId('-invalid')).toBeNull();
    expect(sanitizeContainerId('_invalid')).toBeNull();
  });

  it('rejects container IDs with disallowed characters', () => {
    expect(sanitizeContainerId('abc/def')).toBeNull();
    expect(sanitizeContainerId('abc:def')).toBeNull();
    expect(sanitizeContainerId('abc def')).toBeNull();
    expect(sanitizeContainerId('abc$def')).toBeNull();
    expect(sanitizeContainerId('abc;rm -rf /')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(sanitizeContainerId('')).toBeNull();
  });
});

describe('sanitizeDockerImage', () => {
  it('accepts valid Docker image names', () => {
    expect(sanitizeDockerImage('node:lts-slim')).toBe('node:lts-slim');
    expect(sanitizeDockerImage('node:22-alpine')).toBe('node:22-alpine');
    expect(sanitizeDockerImage('ubuntu')).toBe('ubuntu');
    expect(sanitizeDockerImage('registry.example.com/my-image:v1.0')).toBe(
      'registry.example.com/my-image:v1.0'
    );
  });

  it('accepts images with registry paths', () => {
    expect(sanitizeDockerImage('ghcr.io/org/image:latest')).toBe('ghcr.io/org/image:latest');
    expect(sanitizeDockerImage('docker.io/library/node:20')).toBe('docker.io/library/node:20');
  });

  it('rejects images starting with special characters', () => {
    expect(sanitizeDockerImage('.invalid')).toBeNull();
    expect(sanitizeDockerImage('-invalid')).toBeNull();
    expect(sanitizeDockerImage(':invalid')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(sanitizeDockerImage('')).toBeNull();
  });

  it('rejects images exceeding 200 characters', () => {
    const longImage = `a${'b'.repeat(200)}`;
    expect(sanitizeDockerImage(longImage)).toBeNull();
  });

  it('accepts images at the 200 character boundary', () => {
    const image = `a${'b'.repeat(199)}`;
    expect(sanitizeDockerImage(image)).toBe(image);
  });

  it('rejects images with disallowed characters', () => {
    expect(sanitizeDockerImage('image name')).toBeNull();
    expect(sanitizeDockerImage('image;echo')).toBeNull();
    expect(sanitizeDockerImage('image$var')).toBeNull();
  });
});

describe('sanitizeShellCommand', () => {
  it('accepts valid shell commands', () => {
    expect(sanitizeShellCommand('ls -la')).toBe('ls -la');
    expect(sanitizeShellCommand('echo hello')).toBe('echo hello');
    expect(sanitizeShellCommand('npm install --omit=dev')).toBe('npm install --omit=dev');
    expect(sanitizeShellCommand('node index.mjs')).toBe('node index.mjs');
  });

  it('accepts commands with pipes and redirects', () => {
    expect(sanitizeShellCommand('echo hello | grep h')).toBe('echo hello | grep h');
    expect(sanitizeShellCommand('echo hello > output.txt')).toBe('echo hello > output.txt');
  });

  it('rejects commands with backtick substitution', () => {
    expect(sanitizeShellCommand('echo `whoami`')).toBeNull();
    expect(sanitizeShellCommand('`rm -rf /`')).toBeNull();
  });

  it('rejects commands with $() substitution', () => {
    expect(sanitizeShellCommand('echo $(whoami)')).toBeNull();
    expect(sanitizeShellCommand('$(rm -rf /)')).toBeNull();
  });

  it('rejects empty and whitespace-only strings', () => {
    expect(sanitizeShellCommand('')).toBeNull();
    expect(sanitizeShellCommand('   ')).toBeNull();
    expect(sanitizeShellCommand('\t')).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(sanitizeShellCommand(123 as unknown as string)).toBeNull();
    expect(sanitizeShellCommand(null as unknown as string)).toBeNull();
    expect(sanitizeShellCommand(undefined as unknown as string)).toBeNull();
  });
});
