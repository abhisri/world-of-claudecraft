import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

// Mirror tests/wallet_server.test.ts: stub DATABASE_URL + mock the pg Pool so
// db.ts loads and every pool.query is a spy we route by SQL text. This drives
// the REAL account handlers through every branch with no live database.
const dbMock = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test/test';
  return { query: vi.fn() };
});
vi.mock('pg', () => ({
  Pool: vi.fn(function Pool() { return { query: dbMock.query }; }),
}));

import {
  handleAccountWhoami, handleAccountChangePassword, handleAccountSetEmail, handleAccountDeactivate,
  type AccountGameHooks,
} from '../server/account';
import { hashPassword } from '../server/auth';

// ── http fakes ──────────────────────────────────────────────────────────────
function makeReq(body: unknown): any {
  const req: any = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = { host: 'localhost:8787' };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}
function makeRes(): any {
  return {
    statusCode: 0,
    body: '',
    writeHead(status: number) { this.statusCode = status; return this; },
    end(data: string) { this.body = data ?? ''; return this; },
  };
}
const parse = (res: any) => ({ status: res.statusCode, data: res.body ? JSON.parse(res.body) : {} });

// ── query router ────────────────────────────────────────────────────────────
// Each test sets `accountRow`, `characters`, and `charCount`; the spy returns
// the right rows by inspecting the SQL, and records the writes it sees.
let accountRow: any;
let characters: any[];
let charCount: number;
let writes: { sql: string; params: any[] }[];

function routeQuery(sql: string, params: any[]) {
  writes.push({ sql, params });
  if (sql.includes('FROM accounts WHERE id')) return { rows: accountRow ? [accountRow] : [] };
  if (sql.includes('COUNT(*)')) return { rows: [{ count: charCount }] };
  if (sql.includes('FROM characters WHERE account_id')) return { rows: characters };
  return { rows: [] }; // UPDATE / DELETE writes
}

const CORRECT_PW = 'correct-horse';
let pwHash = '';

beforeEach(async () => {
  pwHash = pwHash || (await hashPassword(CORRECT_PW));
  accountRow = { id: 1, username: 'Aelwyn', password_hash: pwHash, email: null, created_at: '2026-01-15T10:00:00.000Z', deactivated_at: null };
  characters = [{ id: 10 }, { id: 11 }];
  charCount = 2;
  writes = [];
  dbMock.query.mockReset();
  dbMock.query.mockImplementation((sql: string, params: any[]) => routeQuery(sql, params));
});

const noHooks: AccountGameHooks = { anyCharacterOnline: () => false, disconnectAccount: () => {} };

describe('handleAccountWhoami', () => {
  it('returns the account + account-wide character count', async () => {
    const res = makeRes();
    await handleAccountWhoami(res, 1);
    const { status, data } = parse(res);
    expect(status).toBe(200);
    expect(data).toMatchObject({ username: 'Aelwyn', email: '', characterCount: 2 });
  });
  it('404s when the row is gone', async () => {
    accountRow = null;
    const res = makeRes();
    await handleAccountWhoami(res, 1);
    expect(parse(res).status).toBe(404);
  });
});

describe('handleAccountChangePassword', () => {
  it('rejects an incorrect current password (401)', async () => {
    const res = makeRes();
    await handleAccountChangePassword(makeReq({ current: 'wrong', next: 'brandnew1' }), res, 1, 'tokA');
    expect(parse(res).status).toBe(401);
    expect(writes.some((w) => w.sql.includes('UPDATE accounts SET password_hash'))).toBe(false);
  });
  it('rejects a too-short new password (400)', async () => {
    const res = makeRes();
    await handleAccountChangePassword(makeReq({ current: CORRECT_PW, next: 'abc' }), res, 1, 'tokA');
    expect(parse(res).status).toBe(400);
  });
  it('rejects a too-long new password (400)', async () => {
    const res = makeRes();
    await handleAccountChangePassword(makeReq({ current: CORRECT_PW, next: 'a'.repeat(129) }), res, 1, 'tokA');
    const { status, data } = parse(res);
    expect(status).toBe(400);
    expect(data.error).toContain('at most');
  });
  it('changes the password and revokes only OTHER tokens (keeps the caller)', async () => {
    const res = makeRes();
    await handleAccountChangePassword(makeReq({ current: CORRECT_PW, next: 'brandnew1' }), res, 1, 'tokA');
    expect(parse(res).status).toBe(200);
    expect(writes.some((w) => w.sql.includes('UPDATE accounts SET password_hash'))).toBe(true);
    const revoke = writes.find((w) => w.sql.includes('DELETE FROM auth_tokens'));
    expect(revoke).toBeTruthy();
    // The "<> $2" (keep caller) variant, with the caller token as a param.
    expect(revoke!.sql).toContain('token <>');
    expect(revoke!.params).toContain('tokA');
  });
});

describe('handleAccountSetEmail', () => {
  it('rejects a malformed address (400)', async () => {
    const res = makeRes();
    await handleAccountSetEmail(makeReq({ email: 'nope' }), res, 1);
    expect(parse(res).status).toBe(400);
  });
  it('saves a valid address', async () => {
    const res = makeRes();
    await handleAccountSetEmail(makeReq({ email: '  Player@example.com  ' }), res, 1);
    const { status, data } = parse(res);
    expect(status).toBe(200);
    expect(data.email).toBe('Player@example.com');
    const upd = writes.find((w) => w.sql.includes('UPDATE accounts SET email'));
    expect(upd!.params[1]).toBe('Player@example.com');
  });
  it('clears the address when empty', async () => {
    const res = makeRes();
    await handleAccountSetEmail(makeReq({ email: '' }), res, 1);
    expect(parse(res).status).toBe(200);
    const upd = writes.find((w) => w.sql.includes('UPDATE accounts SET email'));
    expect(upd!.params[1]).toBeNull();
  });
});

describe('handleAccountDeactivate', () => {
  it('requires the username to match (400)', async () => {
    const res = makeRes();
    await handleAccountDeactivate(makeReq({ username: 'Nope', password: CORRECT_PW }), res, 1, noHooks);
    expect(parse(res).status).toBe(400);
  });
  it('requires the correct password (401)', async () => {
    const res = makeRes();
    await handleAccountDeactivate(makeReq({ username: 'Aelwyn', password: 'wrong' }), res, 1, noHooks);
    expect(parse(res).status).toBe(401);
  });
  it('409s when a character is still online and does not lock', async () => {
    const hooks: AccountGameHooks = { anyCharacterOnline: (ids) => ids.includes(10), disconnectAccount: vi.fn() };
    const res = makeRes();
    await handleAccountDeactivate(makeReq({ username: 'Aelwyn', password: CORRECT_PW }), res, 1, hooks);
    expect(parse(res).status).toBe(409);
    expect(writes.some((w) => w.sql.includes('SET deactivated_at'))).toBe(false);
    expect(hooks.disconnectAccount).not.toHaveBeenCalled();
  });
  it('locks the account, revokes ALL tokens, and tears down the socket', async () => {
    const disconnectAccount = vi.fn();
    const hooks: AccountGameHooks = { anyCharacterOnline: () => false, disconnectAccount };
    const res = makeRes();
    await handleAccountDeactivate(makeReq({ username: 'Aelwyn', password: CORRECT_PW }), res, 1, hooks);
    expect(parse(res).status).toBe(200);
    expect(writes.some((w) => w.sql.includes('SET deactivated_at'))).toBe(true);
    const revoke = writes.find((w) => w.sql.includes('DELETE FROM auth_tokens'));
    expect(revoke!.sql).not.toContain('token <>'); // revoke-all variant
    expect(disconnectAccount).toHaveBeenCalledWith(1, expect.any(String));
  });
});
