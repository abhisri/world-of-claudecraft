// Player-uploaded GLB assets for the map editor: validation (parseGlbInfo),
// content-addressed sha256 dedupe, per-account count/byte caps, listing and
// deletion, and the moderation block flag. Same split as maps.ts: business
// rules against a narrow UserAssetsDb interface (Postgres in
// user_assets_db.ts; tests use an in-memory fake), zero SQL, zero HTTP.

import { createHash } from 'node:crypto';
import { isUniqueViolation, parseGlbInfo } from './http_util';

// Per-file cap (also prechecked against Content-Length before auth) and the
// per-account totals enforced inside the insert transaction.
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_ASSETS_PER_ACCOUNT = 20;
export const MAX_ASSET_TOTAL_BYTES = 24 * 1024 * 1024;
export const MAX_ASSET_NAME_LENGTH = 80;

export type AssetStatus = 'active' | 'blocked';

export interface UserAssetRecord {
  id: number;
  accountId: number;
  sha256: string;
  byteSize: number;
  name: string | null;
  status: AssetStatus;
  createdAt: string;
}

export type UserAssetsErrorCode =
  | 'invalid_glb'
  | 'asset_blocked'
  | 'asset_limit_reached'
  | 'asset_storage_limit_reached';

export type UserAssetUploadResult =
  | { ok: true; asset: UserAssetRecord; existing: boolean }
  | { ok: false; error: UserAssetsErrorCode };

export function userAssetsErrorStatus(code: UserAssetsErrorCode): number {
  return code === 'asset_blocked' ? 403 : 400;
}

/** The public, content-addressed URL an asset's bytes are served from. */
export function userAssetUrl(sha256: string): string {
  return `/api/assets/${sha256}.glb`;
}

export function userAssetJson(asset: UserAssetRecord): Record<string, unknown> {
  return {
    id: asset.id,
    sha256: asset.sha256,
    byteSize: asset.byteSize,
    name: asset.name,
    status: asset.status,
    createdAt: asset.createdAt,
    url: userAssetUrl(asset.sha256),
  };
}

// Storage abstraction; the Postgres implementation enforces the caps inside a
// FOR UPDATE + count/sum transaction and relies on the UNIQUE sha256 index (a
// violation is caught here as a concurrent duplicate upload).
export interface UserAssetsDb {
  findBySha(sha256: string): Promise<UserAssetRecord | null>;
  insertAssetCapped(
    input: { accountId: number; sha256: string; bytes: Buffer; name: string | null },
    maxCount: number,
    maxTotalBytes: number,
  ): Promise<UserAssetRecord | 'cap_count' | 'cap_bytes'>;
  /** Bytes for a stored asset, or null when missing or blocked. */
  getActiveBytes(sha256: string): Promise<Buffer | null>;
  listForAccount(accountId: number): Promise<UserAssetRecord[]>;
  deleteAsset(id: number, accountId: number): Promise<boolean>;
}

export class UserAssetsService {
  constructor(private readonly db: UserAssetsDb) {}

  async upload(accountId: number, bytes: Buffer, rawName: unknown): Promise<UserAssetUploadResult> {
    if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES) {
      return { ok: false, error: 'invalid_glb' };
    }
    if (!parseGlbInfo(bytes)) return { ok: false, error: 'invalid_glb' };
    const name =
      typeof rawName === 'string' && rawName.trim()
        ? rawName.trim().slice(0, MAX_ASSET_NAME_LENGTH)
        : null;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // Content-addressed dedupe: the same bytes are one row, whoever uploads
    // them; a blocked hash stays blocked no matter who re-uploads it.
    const existing = await this.db.findBySha(sha256);
    if (existing) {
      if (existing.status === 'blocked') return { ok: false, error: 'asset_blocked' };
      return { ok: true, asset: existing, existing: true };
    }
    try {
      const inserted = await this.db.insertAssetCapped(
        { accountId, sha256, bytes, name },
        MAX_ASSETS_PER_ACCOUNT,
        MAX_ASSET_TOTAL_BYTES,
      );
      if (inserted === 'cap_count') return { ok: false, error: 'asset_limit_reached' };
      if (inserted === 'cap_bytes') return { ok: false, error: 'asset_storage_limit_reached' };
      return { ok: true, asset: inserted, existing: false };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A concurrent upload of the same bytes won the insert; serve its row.
      const raced = await this.db.findBySha(sha256);
      if (!raced) throw err;
      if (raced.status === 'blocked') return { ok: false, error: 'asset_blocked' };
      return { ok: true, asset: raced, existing: true };
    }
  }

  /** Bytes for the public GET; null covers both missing and blocked (a 404). */
  bytesForSha(sha256: string): Promise<Buffer | null> {
    return this.db.getActiveBytes(sha256);
  }

  listMine(accountId: number): Promise<UserAssetRecord[]> {
    return this.db.listForAccount(accountId);
  }

  deleteAsset(accountId: number, assetId: number): Promise<boolean> {
    return this.db.deleteAsset(assetId, accountId);
  }
}
