import { describe, expect, it } from 'vitest';
import {
  setWocBalance,
  verifiedWocBalance,
  wocBalance,
  wocBalanceVerified,
} from '../src/ui/wallet_balance';

describe('wallet balance UI state', () => {
  it('treats connected-wallet balances as unverified previews by default', () => {
    setWocBalance(null);
    setWocBalance(125);

    expect(wocBalance()).toBe(125);
    expect(wocBalanceVerified()).toBe(false);
    expect(verifiedWocBalance()).toBeNull();
  });

  it('exposes a verified balance only after the account link is known', () => {
    setWocBalance(42, true);

    expect(wocBalance()).toBe(42);
    expect(wocBalanceVerified()).toBe(true);
    expect(verifiedWocBalance()).toBe(42);
  });

  it('clears verification when the balance is cleared', () => {
    setWocBalance(null, true);

    expect(wocBalance()).toBeNull();
    expect(wocBalanceVerified()).toBe(false);
    expect(verifiedWocBalance()).toBeNull();
  });
});
