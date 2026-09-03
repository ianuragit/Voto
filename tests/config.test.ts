import { describe, expect, it } from 'vitest';
import { buildConfig, detectDeployment, resolveBindHost } from '../src/config.js';

const DEV_SECRET = 'dev-only-insecure-secret-change-me';

const base = {
  PUBLIC_BASE_URL: 'https://voto.example.com',
  SESSION_SECRET: 'a-real-production-secret-value',
  ALLOWED_CREATORS: 'ravi@example.com',
} as NodeJS.ProcessEnv;

describe('a deployment is recognised however NODE_ENV is set', () => {
  it('trusts an explicit production', () => {
    expect(detectDeployment({ NODE_ENV: 'production' })).toBe(true);
  });

  it('recognises the platform even when NODE_ENV says development', () => {
    // Exactly the case that shipped to production with insecure cookies.
    expect(detectDeployment({ NODE_ENV: 'development', RAILWAY_ENVIRONMENT: 'production' })).toBe(
      true,
    );
    expect(detectDeployment({ NODE_ENV: 'development', DYNO: 'web.1' })).toBe(true);
    expect(detectDeployment({ NODE_ENV: 'development', FLY_APP_NAME: 'voto' })).toBe(true);
  });

  it('leaves a laptop and the test suite alone', () => {
    expect(detectDeployment({ NODE_ENV: 'development' })).toBe(false);
    expect(detectDeployment({ NODE_ENV: 'test', RAILWAY_ENVIRONMENT: 'x' })).toBe(false);
  });
});

describe('the bind address is one this machine can actually use', () => {
  const local = ['127.0.0.1', '10.0.0.5'];

  it('refuses an address the machine does not hold', () => {
    // EADDRNOTAVAIL crash-looped the container on exactly this value.
    expect(resolveBindHost('169.148.149.171', local)).toEqual({
      host: '0.0.0.0',
      rejected: '169.148.149.171',
    });
  });

  it('keeps a wildcard, a loopback, or a real local address', () => {
    expect(resolveBindHost('0.0.0.0', local).rejected).toBeNull();
    expect(resolveBindHost('::', local).rejected).toBeNull();
    expect(resolveBindHost('localhost', local).rejected).toBeNull();
    expect(resolveBindHost('10.0.0.5', local)).toEqual({ host: '10.0.0.5', rejected: null });
  });

  it('treats an empty host as every interface', () => {
    expect(resolveBindHost('', local)).toEqual({ host: '0.0.0.0', rejected: null });
  });
});

describe('a deployment refuses to run insecurely', () => {
  it('will not boot on the development secret, which is public in this repo', () => {
    expect(() =>
      buildConfig({ ...base, RAILWAY_ENVIRONMENT: 'production', SESSION_SECRET: DEV_SECRET }),
    ).toThrow(/SESSION_SECRET/);
  });

  it('will not boot with nobody allowed to create a poll', () => {
    expect(() =>
      buildConfig({ ...base, RAILWAY_ENVIRONMENT: 'production', ALLOWED_CREATORS: '' }),
    ).toThrow(/ALLOWED_CREATORS/);
  });

  it('still allows the development secret on a laptop', () => {
    expect(() => buildConfig({ NODE_ENV: 'development', SESSION_SECRET: DEV_SECRET })).not.toThrow();
  });

  it('hardens cookies and logging on a deployment that claims to be development', () => {
    const config = buildConfig({ ...base, NODE_ENV: 'development', RAILWAY_ENVIRONMENT: 'x' });
    expect(config.isDeployed).toBe(true); // drives Secure cookies and HSTS
    expect(config.isProduction).toBe(false); // NODE_ENV is still reported honestly
    expect(config.logLevel).toBe('warn'); // §6.3
  });
});

describe('an ephemeral data directory is detectable', () => {
  it('flags a relative path, which dies with the container', () => {
    expect(buildConfig({ ...base, DATA_DIR: './data' }).dataIsEphemeral).toBe(true);
    expect(buildConfig({ ...base, DATA_DIR: 'data' }).dataIsEphemeral).toBe(true);
  });

  it('accepts a mounted volume path', () => {
    expect(buildConfig({ ...base, DATA_DIR: '/data' }).dataIsEphemeral).toBe(false);
  });
});
