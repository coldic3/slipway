import { describe, expect, it } from 'vitest';
import { resolveOwnerCredentials } from '../../src/setup/bootstrap.ts';

describe('resolveOwnerCredentials', () => {
  it('defaults to slipway / slipway', () => {
    expect(resolveOwnerCredentials({}, undefined)).toEqual({ username: 'slipway', password: 'slipway' });
  });
  it('explicit values win', () => {
    expect(resolveOwnerCredentials({ ownerUser: 'kevin', ownerPassword: 'pw123456' }, undefined)).toEqual({ username: 'kevin', password: 'pw123456' });
  });
  it('re-running setup keeps a custom password of the same user', () => {
    const previous = { owner: { username: 'slipway', password: 'custom-pw', token: 't' } };
    expect(resolveOwnerCredentials({}, previous)).toEqual({ username: 'slipway', password: 'custom-pw' });
  });
  it('re-running setup keeps the stored login', () => {
    const previous = { owner: { username: 'kevin', password: 'pw123456', token: 't' } };
    expect(resolveOwnerCredentials({}, previous)).toEqual({ username: 'kevin', password: 'pw123456' });
  });
  it('an explicit different user starts from the default password', () => {
    const previous = { owner: { username: 'kevin', password: 'custom-pw', token: 't' } };
    expect(resolveOwnerCredentials({ ownerUser: 'anna' }, previous)).toEqual({ username: 'anna', password: 'slipway' });
  });
});

import { keepValidClaude } from '../../src/setup/bootstrap.ts';

describe('keepValidClaude (I-2)', () => {
  const claude = { username: 'claude-mac', password: 'x', token: 't' };
  it('keeps a Claude identity Gitea still accepts', async () => {
    expect(await keepValidClaude(claude, async () => true)).toEqual(claude);
  });
  it('drops it after the instance was reset, so the plugin re-enrolls and repo add does not fail', async () => {
    expect(await keepValidClaude(claude, async () => false)).toBeUndefined();
  });
  it('nothing to keep', async () => {
    expect(await keepValidClaude(undefined, async () => true)).toBeUndefined();
  });
});
