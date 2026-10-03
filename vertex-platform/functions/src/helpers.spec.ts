import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@google-cloud/secret-manager', () => {
  return {
    SecretManagerServiceClient: class {
      accessSecretVersion = vi.fn().mockRejectedValue(new Error('Secret not found in test'));
    },
  };
});

import { pickBillingAccount, retry } from './helpers';
import type { Firestore } from 'firebase-admin/firestore';

// ─── retry ───────────────────────────────────────────────────────────────────

describe('retry', () => {
  it('returns immediately on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retry(fn, 3, 0);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('retries on failure and succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('success');
    const result = await retry(fn, 3, 0);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws last error when all attempts exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(retry(fn, 3, 0)).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

// ─── pickBillingAccount ───────────────────────────────────────────────────────

function makeDb(
  accounts: Array<{ id: string; maxProjects: number }>,
  storeUsage: Array<{ billingAccountId: string }>,
): Firestore {
  const accountsDocs = accounts.map((a) => ({
    id: a.id,
    data: () => ({ active: true, maxProjects: a.maxProjects }),
  }));
  const storesDocs = storeUsage.map((s, i) => ({
    id: `store-${i}`,
    data: () => ({ billingAccountId: s.billingAccountId }),
  }));

  return {
    collection: vi.fn((name: string) => ({
      where: vi.fn().mockReturnThis(),
      get: vi.fn().mockResolvedValue({
        empty:
          name === 'billingAccounts' || name === 'billing_accounts'
            ? accountsDocs.length === 0
            : false,
        docs: name === 'billingAccounts' || name === 'billing_accounts' ? accountsDocs : storesDocs,
      }),
    })),
  } as unknown as Firestore;
}

describe('pickBillingAccount', () => {
  it('throws when no billing accounts exist', async () => {
    const db = makeDb([], []);
    await expect(pickBillingAccount(db)).rejects.toThrow('No active billing accounts');
  });

  it('returns the single account if it has capacity', async () => {
    const db = makeDb([{ id: 'acc-1', maxProjects: 10 }], []);
    const result = await pickBillingAccount(db);
    expect(result).toBe('acc-1');
  });

  it('throws when the only account is at full capacity', async () => {
    const db = makeDb(
      [{ id: 'acc-1', maxProjects: 2 }],
      [{ billingAccountId: 'acc-1' }, { billingAccountId: 'acc-1' }],
    );
    await expect(pickBillingAccount(db)).rejects.toThrow('at capacity');
  });

  it('picks the account with most remaining capacity', async () => {
    const db = makeDb(
      [
        { id: 'acc-1', maxProjects: 10 },
        { id: 'acc-2', maxProjects: 10 },
      ],
      [
        { billingAccountId: 'acc-1' },
        { billingAccountId: 'acc-1' },
        { billingAccountId: 'acc-1' },
        { billingAccountId: 'acc-2' },
      ],
    );
    // acc-1 has 7 remaining, acc-2 has 9 remaining → should pick acc-2
    const result = await pickBillingAccount(db);
    expect(result).toBe('acc-2');
  });

  it('handles account with no usage yet', async () => {
    const db = makeDb(
      [
        { id: 'acc-full', maxProjects: 1 },
        { id: 'acc-empty', maxProjects: 5 },
      ],
      [{ billingAccountId: 'acc-full' }],
    );
    // acc-full: 0 remaining, acc-empty: 5 remaining
    const result = await pickBillingAccount(db);
    expect(result).toBe('acc-empty');
  });

  it('prefers billing_accounts with status ACTIVE and filters by currentProjects < maxProjects', async () => {
    const db = {
      collection: vi.fn((name: string) => {
        if (name === 'billing_accounts') {
          return {
            where: vi.fn().mockReturnThis(),
            get: vi.fn().mockResolvedValue({
              empty: false,
              docs: [
                // acc-a is at capacity (10/10) → must be excluded
                {
                  id: 'acc-a',
                  data: () => ({ status: 'ACTIVE', maxProjects: 10, currentProjects: 10 }),
                },
                // acc-b has 7 remaining → selected
                {
                  id: 'acc-b',
                  data: () => ({ status: 'ACTIVE', maxProjects: 10, currentProjects: 3 }),
                },
              ],
            }),
          };
        }
        return {
          where: vi.fn().mockReturnThis(),
          get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
        };
      }),
    } as unknown as Firestore;

    const result = await pickBillingAccount(db);
    expect(result).toBe('acc-b');
  });
});

// ─── notifyAdminNewStoreCreated & sendDirectEmail ──────────────────────────────

describe('notifyAdminNewStoreCreated', () => {
  it('formats complimentary subscription plan correctly and attempts send', async () => {
    const { notifyAdminNewStoreCreated } = await import('./helpers');
    await expect(
      notifyAdminNewStoreCreated({
        storeId: 'test-store',
        storeName: 'Test Store',
        slug: 'test-store',
        ownerEmail: 'owner@test.com',
        subscriptionStatus: 'complimentary',
      }),
    ).resolves.toBeUndefined();
  });

  it('formats trial subscription plan with days correctly', async () => {
    const { notifyAdminNewStoreCreated } = await import('./helpers');
    await expect(
      notifyAdminNewStoreCreated({
        storeId: 'trial-store',
        storeName: 'Trial Store',
        slug: 'trial-store',
        ownerEmail: 'trial@test.com',
        subscriptionStatus: 'trial',
        trialDays: 7,
      }),
    ).resolves.toBeUndefined();
  });
});

import * as crypto from 'crypto';
import {
  generateGitHubAppJwt,
  getGitHubAppToken,
  getGitHubPat,
  getDeployToken,
  calculateDeploySequence,
  _resetGitHubTokenCacheForTesting,
  secretsClient,
} from './helpers';

describe('GitHub App & PAT token resolver', () => {
  beforeEach(() => {
    _resetGitHubTokenCacheForTesting();
    vi.restoreAllMocks();
  });

  it('generateGitHubAppJwt signs a valid 3-part RS256 JWT', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const jwt = generateGitHubAppJwt('5157671', pem);
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    expect(payload.iss).toBe('5157671');
  });

  it('getGitHubAppToken fetches and caches installation token', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

    vi.spyOn(secretsClient, 'accessSecretVersion').mockResolvedValueOnce([
      { payload: { data: Buffer.from(pem) } },
    ] as any);

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        token: 'mock-bot-token',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const token = await getGitHubAppToken('5157671', '167069206');
    expect(token).toBe('mock-bot-token');
    expect(mockFetch).toHaveBeenCalledOnce();

    const cached = await getGitHubAppToken('5157671', '167069206');
    expect(cached).toBe('mock-bot-token');
    expect(mockFetch).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('getGitHubAppToken returns null on fetch failure or missing secret', async () => {
    vi.spyOn(secretsClient, 'accessSecretVersion').mockRejectedValueOnce(new Error('no key'));
    const token = await getGitHubAppToken('5157671', '167069206');
    expect(token).toBeNull();
  });

  it('getGitHubPat returns app bot token when available', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

    vi.spyOn(secretsClient, 'accessSecretVersion').mockResolvedValueOnce([
      { payload: { data: Buffer.from(pem) } },
    ] as any);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: 'bot-token-active',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        }),
      }),
    );

    const result = await getGitHubPat();
    expect(result).toBe('bot-token-active');
    vi.unstubAllGlobals();
  });

  it('getGitHubPat falls back to github-pat secret when app token fails', async () => {
    vi.spyOn(secretsClient, 'accessSecretVersion')
      .mockRejectedValueOnce(new Error('no app key'))
      .mockResolvedValueOnce([{ payload: { data: Buffer.from('legacy-pat-value') } }] as any);

    const result = await getGitHubPat();
    expect(result).toBe('legacy-pat-value');
  });

  it('getDeployToken fetches and caches deploy token', async () => {
    vi.spyOn(secretsClient, 'accessSecretVersion').mockResolvedValueOnce([
      { payload: { data: Buffer.from('test-deploy-token') } },
    ] as any);
    const token = await getDeployToken();
    expect(token).toBe('test-deploy-token');
  });
});

describe('calculateDeploySequence', () => {
  it('returns deploy 1 and redeploy 0 when store has no deploy history', async () => {
    const db = {
      collection: vi.fn(() => ({
        doc: vi.fn(() => ({
          get: vi.fn().mockResolvedValue({
            exists: true,
            data: () => ({ id: 'store-1' }),
          }),
          collection: vi.fn(() => ({
            get: vi.fn().mockResolvedValue({ empty: true, size: 0 }),
          })),
        })),
      })),
    } as unknown as Firestore;

    const res = await calculateDeploySequence(db, 'store-1');
    expect(res.deployNumber).toBe(1);
    expect(res.redeployNumber).toBe(0);
    expect(res.isRedeploy).toBe(false);
    expect(typeof res.deployTimestamp).toBe('string');
  });

  it('uses deployCount field when available on store document', async () => {
    const db = {
      collection: vi.fn(() => ({
        doc: vi.fn(() => ({
          get: vi.fn().mockResolvedValue({
            exists: true,
            data: () => ({ id: 'store-2', deployCount: 3 }),
          }),
        })),
      })),
    } as unknown as Firestore;

    const res = await calculateDeploySequence(db, 'store-2');
    expect(res.deployNumber).toBe(4);
    expect(res.redeployNumber).toBe(3);
    expect(res.isRedeploy).toBe(true);
  });

  it('counts previous deploys from deploys subcollection when deployCount is absent', async () => {
    const db = {
      collection: vi.fn(() => ({
        doc: vi.fn(() => ({
          get: vi.fn().mockResolvedValue({
            exists: true,
            data: () => ({ id: 'store-3' }),
          }),
          collection: vi.fn(() => ({
            get: vi.fn().mockResolvedValue({ empty: false, size: 2 }),
          })),
        })),
      })),
    } as unknown as Firestore;

    const res = await calculateDeploySequence(db, 'store-3');
    expect(res.deployNumber).toBe(3);
    expect(res.redeployNumber).toBe(2);
    expect(res.isRedeploy).toBe(true);
  });

  it('counts previous deploys from deploy_history subcollection when available', async () => {
    const db = {
      collection: vi.fn(() => ({
        doc: vi.fn(() => ({
          get: vi.fn().mockResolvedValue({
            exists: true,
            data: () => ({ id: 'store-history' }),
          }),
          collection: vi.fn((subCol: string) => ({
            get: vi.fn().mockResolvedValue({
              empty: subCol !== 'deploy_history',
              size: subCol === 'deploy_history' ? 4 : 0,
            }),
          })),
        })),
      })),
    } as unknown as Firestore;

    const res = await calculateDeploySequence(db, 'store-history');
    expect(res.deployNumber).toBe(5);
    expect(res.redeployNumber).toBe(4);
    expect(res.isRedeploy).toBe(true);
  });

  it('safely falls back to deploy 1 on database read error', async () => {
    const db = {
      collection: vi.fn(() => ({
        doc: vi.fn(() => ({
          get: vi.fn().mockRejectedValue(new Error('Firestore error')),
        })),
      })),
    } as unknown as Firestore;

    const res = await calculateDeploySequence(db, 'store-err');
    expect(res.deployNumber).toBe(1);
    expect(res.redeployNumber).toBe(0);
    expect(res.isRedeploy).toBe(false);
  });
});

describe('recordStoreDeployHistory', () => {
  it('records deploy in deploy_history, deploys, and updates deployCount', async () => {
    const addHistoryMock = vi.fn().mockResolvedValue({ id: 'hist-1' });
    const addDeploysMock = vi.fn().mockResolvedValue({ id: 'dep-1' });
    const updateStoreMock = vi.fn().mockResolvedValue({});

    const db = {
      collection: vi.fn(() => ({
        doc: vi.fn(() => ({
          get: vi.fn().mockResolvedValue({
            exists: true,
            data: () => ({ id: 'store-rec', deployCount: 1 }),
          }),
          collection: vi.fn((subCol: string) => {
            if (subCol === 'deploy_history') return { add: addHistoryMock };
            if (subCol === 'deploys') return { add: addDeploysMock };
            return { get: vi.fn().mockResolvedValue({ empty: true, size: 0 }) };
          }),
          update: updateStoreMock,
        })),
      })),
    } as unknown as Firestore;

    const { recordStoreDeployHistory } = await import('./helpers');
    await recordStoreDeployHistory({
      db,
      storeId: 'store-rec',
      success: true,
      version: '0.9.0',
      commitSha: 'abcdef1',
      commitMessage: 'test commit',
      ref: 'main',
    });

    expect(addHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        version: '0.9.0',
        deployLabel: 'Redespliegue 1',
        deployNumber: 2,
        redeployNumber: 1,
        isRedeploy: true,
        success: true,
      }),
    );
    expect(addDeploysMock).toHaveBeenCalledWith(
      expect.objectContaining({
        version: '0.9.0',
        deployLabel: 'Redespliegue 1',
      }),
    );
    expect(updateStoreMock).toHaveBeenCalledWith({
      deployCount: 2,
    });
  });
});
