import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// db.ts and oauth_db.ts touch Postgres; mock both so we exercise the OAuth
// handler logic (PKCE, one-time codes, device grant) with no DB.
vi.mock('../server/db', () => ({
  pool: {},
  saveToken: vi.fn(async () => {}),
  accountAndScopeForToken: vi.fn(async () => ({ accountId: 5, scope: 'full' })),
  moderationStatusForAccount: vi.fn(async () => ({ locked: false, message: '' })),
  revokeReadToken: vi.fn(async () => true),
}));
vi.mock('../server/oauth_db', () => ({
  getOAuthClient: vi.fn(async () => ({ client_id: 'companion', name: 'Companion', redirect_uris: 'https://app.example/cb' })),
  upsertOAuthClient: vi.fn(async () => {}),
  createAuthCode: vi.fn(async () => {}),
  consumeAuthCode: vi.fn(),
  createDeviceCode: vi.fn(async () => {}),
  getDeviceByUserCode: vi.fn(),
  approveDeviceCode: vi.fn(),
  getDeviceByDeviceCode: vi.fn(),
  consumeDeviceCode: vi.fn(),
}));

const {
  handleOAuth, verifyPkce, pkceChallengeFromVerifier, newUserCode, normalizeUserCode, redirectAllowed,
} = await import('../server/oauth');
const db = await import('../server/db');
const oauthDb = await import('../server/oauth_db');

function makeReq(method: string, url: string, body: unknown, headers: Record<string, string> = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  const req: any = Readable.from([Buffer.from(payload)]);
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': 'application/json', ...headers };
  return req;
}
function makeRes() {
  return {
    statusCode: 0, body: '', headers: {} as Record<string, unknown>,
    writeHead(s: number, h?: Record<string, unknown>) { this.statusCode = s; if (h) Object.assign(this.headers, h); },
    setHeader(k: string, v: unknown) { this.headers[k] = v; },
    end(d?: string) { this.body = d ?? ''; },
  };
}
async function call(method: string, url: string, body: unknown, headers?: Record<string, string>) {
  const res = makeRes();
  await handleOAuth(makeReq(method, url, body, headers), res as any);
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

const BEARER = { authorization: `Bearer ${'a'.repeat(64)}` };

beforeEach(() => {
  vi.clearAllMocks();
  (db.accountAndScopeForToken as any).mockResolvedValue({ accountId: 5, scope: 'full' });
  (db.moderationStatusForAccount as any).mockResolvedValue({ locked: false, message: '' });
  (oauthDb.getOAuthClient as any).mockResolvedValue({ client_id: 'companion', name: 'Companion', redirect_uris: 'https://app.example/cb' });
});

describe('PKCE', () => {
  it('matches the RFC 7636 S256 test vector', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(pkceChallengeFromVerifier(verifier)).toBe(challenge);
    expect(verifyPkce(verifier, challenge, 'S256')).toBe(true);
  });
  it('rejects a tampered verifier and unknown methods', () => {
    const verifier = 'a'.repeat(43);
    const challenge = pkceChallengeFromVerifier(verifier);
    expect(verifyPkce('b'.repeat(43), challenge, 'S256')).toBe(false);
    expect(verifyPkce(verifier, challenge, 'weird')).toBe(false);
    expect(verifyPkce('', challenge, 'S256')).toBe(false);
  });
});

describe('user codes & redirect allowlist', () => {
  it('formats user codes as XXXX-XXXX from an unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = newUserCode();
      expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ23456789]{4}-[BCDFGHJKLMNPQRSTVWXZ23456789]{4}$/);
      expect(normalizeUserCode(code)).toHaveLength(8);
    }
  });
  it('matches redirect URIs exactly against the allowlist', () => {
    const list = 'https://app.example/cb\nhttps://other.example/done';
    expect(redirectAllowed(list, 'https://app.example/cb')).toBe(true);
    expect(redirectAllowed(list, 'https://app.example/cb/evil')).toBe(false);
    expect(redirectAllowed(list, 'https://evil.example/cb')).toBe(false);
  });
});

describe('authorization-code grant (happy path, one-time, PKCE)', () => {
  it('issues a read token on a valid code + verifier', async () => {
    const verifier = 'v'.repeat(43);
    (oauthDb.consumeAuthCode as any).mockResolvedValueOnce({
      account_id: 5, client_id: 'companion', redirect_uri: 'https://app.example/cb',
      code_challenge: pkceChallengeFromVerifier(verifier), code_challenge_method: 'S256', scope: 'character:read',
    });
    const r = await call('POST', '/oauth/token', {
      grant_type: 'authorization_code', code: 'thecode', code_verifier: verifier,
      client_id: 'companion', redirect_uri: 'https://app.example/cb',
    });
    expect(r.status).toBe(200);
    expect(r.json.token_type).toBe('bearer');
    expect(r.json.scope).toBe('character:read');
    expect(r.json.access_token).toMatch(/^[a-f0-9]{64}$/);
    // The issued token is persisted as scope='read'.
    expect(db.saveToken).toHaveBeenCalledWith(expect.any(String), 5, expect.any(Number), 'read', expect.stringContaining('oauth:'));
  });

  it('rejects a reused (already-consumed) code', async () => {
    (oauthDb.consumeAuthCode as any).mockResolvedValueOnce(null); // already consumed → null
    const r = await call('POST', '/oauth/token', {
      grant_type: 'authorization_code', code: 'thecode', code_verifier: 'v'.repeat(43),
      client_id: 'companion', redirect_uri: 'https://app.example/cb',
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid_grant');
    expect(db.saveToken).not.toHaveBeenCalled();
  });

  it('rejects a bad PKCE verifier', async () => {
    (oauthDb.consumeAuthCode as any).mockResolvedValueOnce({
      account_id: 5, client_id: 'companion', redirect_uri: 'https://app.example/cb',
      code_challenge: pkceChallengeFromVerifier('the-real-verifier'), code_challenge_method: 'S256', scope: 'character:read',
    });
    const r = await call('POST', '/oauth/token', {
      grant_type: 'authorization_code', code: 'thecode', code_verifier: 'wrong-verifier',
      client_id: 'companion', redirect_uri: 'https://app.example/cb',
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid_grant');
    expect(db.saveToken).not.toHaveBeenCalled();
  });
});

describe('device-code grant', () => {
  const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

  it('reports authorization_pending until approved, then issues a token once', async () => {
    (oauthDb.getDeviceByDeviceCode as any).mockResolvedValueOnce({ account_id: null, approved: false, scope: 'character:read', expired: false, consumed: false });
    const pending = await call('POST', '/oauth/token', { grant_type: DEVICE_GRANT, device_code: 'dc', client_id: 'companion' });
    expect(pending.status).toBe(400);
    expect(pending.json.error).toBe('authorization_pending');

    (oauthDb.getDeviceByDeviceCode as any).mockResolvedValueOnce({ account_id: 5, approved: true, scope: 'character:read', expired: false, consumed: false });
    (oauthDb.consumeDeviceCode as any).mockResolvedValueOnce({ account_id: 5, scope: 'character:read' });
    const ok = await call('POST', '/oauth/token', { grant_type: DEVICE_GRANT, device_code: 'dc', client_id: 'companion' });
    expect(ok.status).toBe(200);
    expect(ok.json.access_token).toMatch(/^[a-f0-9]{64}$/);
    expect(db.saveToken).toHaveBeenCalledWith(expect.any(String), 5, expect.any(Number), 'read', expect.any(String));
  });

  it('rejects an expired device code', async () => {
    (oauthDb.getDeviceByDeviceCode as any).mockResolvedValueOnce({ account_id: null, approved: false, scope: 'character:read', expired: true, consumed: false });
    const r = await call('POST', '/oauth/token', { grant_type: DEVICE_GRANT, device_code: 'dc', client_id: 'companion' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('expired_token');
  });

  it('starts a device authorization with a user code + poll interval', async () => {
    const r = await call('POST', '/oauth/device_authorization', { client_id: 'companion' });
    expect(r.status).toBe(200);
    expect(r.json.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ23456789]{4}-[BCDFGHJKLMNPQRSTVWXZ23456789]{4}$/);
    expect(r.json.device_code).toMatch(/^[a-f0-9]{64}$/);
    expect(r.json.interval).toBeGreaterThan(0);
    expect(oauthDb.createDeviceCode).toHaveBeenCalled();
  });
});

describe('authorize approval reuses the web session', () => {
  it('creates a code and returns a redirect for a full session', async () => {
    const r = await call('POST', '/oauth/authorize', {
      client_id: 'companion', redirect_uri: 'https://app.example/cb',
      code_challenge: 'abc', code_challenge_method: 'S256', state: 'xyz',
    }, BEARER);
    expect(r.status).toBe(200);
    expect(r.json.redirect).toContain('https://app.example/cb?');
    expect(r.json.redirect).toContain('state=xyz');
    expect(oauthDb.createAuthCode).toHaveBeenCalled();
  });

  it('refuses to authorize with a read-only token (no escalation)', async () => {
    (db.accountAndScopeForToken as any).mockResolvedValue({ accountId: 5, scope: 'read' });
    const r = await call('POST', '/oauth/authorize', {
      client_id: 'companion', redirect_uri: 'https://app.example/cb',
      code_challenge: 'abc', code_challenge_method: 'S256',
    }, BEARER);
    expect(r.status).toBe(401);
    expect(oauthDb.createAuthCode).not.toHaveBeenCalled();
  });
});

describe('POST /oauth/revoke (RFC 7009)', () => {
  it('revokes the presented token and returns 200', async () => {
    const r = await call('POST', '/oauth/revoke', { token: 'a'.repeat(64) });
    expect(r.status).toBe(200);
    // It deletes only via the scope='read'-restricted revoke (never a full session).
    expect(db.revokeReadToken).toHaveBeenCalledWith('a'.repeat(64));
  });

  it('accepts a form-encoded body', async () => {
    const r = await call('POST', '/oauth/revoke', 'token=' + 'b'.repeat(64), {
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(r.status).toBe(200);
    expect(db.revokeReadToken).toHaveBeenCalledWith('b'.repeat(64));
  });

  it('still returns 200 for an unknown / already-revoked token', async () => {
    (db.revokeReadToken as any).mockResolvedValueOnce(false);
    const r = await call('POST', '/oauth/revoke', { token: 'deadbeef' });
    expect(r.status).toBe(200);
  });

  it('returns 200 with no token and does not call the DB', async () => {
    const r = await call('POST', '/oauth/revoke', {});
    expect(r.status).toBe(200);
    expect(db.revokeReadToken).not.toHaveBeenCalled();
  });
});
