import { describe, expect, it } from 'vitest';

import { loadRuntimeConfig } from '../src/config/runtime.js';

describe('loadRuntimeConfig', () => {
  it('uses defaults when no args are provided', () => {
    const config = loadRuntimeConfig([], {});

    expect(config.transport).toBe('stdio');
    expect(config.http.host).toBe('127.0.0.1');
    expect(config.http.port).toBe(8788);
    expect(config.http.path).toBe('/mcp');
    expect(config.dynamic.storeFilePath.endsWith('.dynamic-mcp/tools.json')).toBe(true);
    expect(config.dynamic.maxTools).toBe(256);
  });

  it('reads CLI flags and normalizes path', () => {
    const config = loadRuntimeConfig(
      [
        '--transport',
        'http',
        '--path',
        'gateway',
        '--dynamic-max-tools',
        '12',
        '--admin-token',
        'secret-token'
      ],
      {}
    );

    expect(config.transport).toBe('http');
    expect(config.http.path).toBe('/gateway');
    expect(config.dynamic.maxTools).toBe(12);
    expect(config.dynamic.adminToken).toBe('secret-token');
  });

  it('rejects invalid transport', () => {
    expect(() => loadRuntimeConfig(['--transport', 'bad'], {})).toThrow(
      /Unsupported transport/
    );
  });
});
