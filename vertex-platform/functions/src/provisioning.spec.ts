import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock firebase-admin before importing provisionStoreV2
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
}));
vi.mock('firebase-admin/storage', () => ({
  getStorage: vi.fn(() => ({
    bucket: vi.fn(() => ({
      setCorsConfiguration: vi.fn().mockResolvedValue(undefined),
    })),
  })),
}));
vi.mock('firebase-functions/v2/https', () => ({
  onCall: vi.fn((_opts: unknown, handler: unknown) => handler),
  HttpsError: class HttpsError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('firebase-functions/v2/firestore', () => ({
  onDocumentCreated: vi.fn(),
}));
vi.mock('./helpers', () => ({
  ALLOWED_ORIGINS: [],
  PLATFORM_PROJECT: 'vertex-platform-dev',
  pickBillingAccount: vi.fn().mockResolvedValue('billing-1'),
  listProvisioningOwnerCandidates: vi.fn().mockResolvedValue([
    {
      id: 'owner-1',
      client_id: 'client',
      client_secret: 'secret',
      refresh_token: 'refresh',
    },
  ]),
  getOwnerOAuthClient: vi.fn(),
  getGitHubPat: vi.fn(),
  apiFetch: vi.fn(),
  retry: vi.fn(),
  pollOperation: vi.fn(),
}));

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  formatProjectDisplayName,
  normalizeAuthorizedDomain,
  retryProvisioningV2,
} from './provisioning';

const VALID_PAYLOAD = {
  name: 'Test Store',
  slug: 'my-store',
  ownerEmail: 'owner@test.com',
};

function makeRequest(data: Record<string, unknown>, isAdmin = true) {
  return {
    auth: isAdmin ? { token: { platformAdmin: true } } : { token: {} },
    data,
  };
}

function makeDb(slugExists = false, mockShards: any[] = []) {
  const defaultShard = {
    id: 'shared-dev-01',
    environment: 'development',
    status: 'ACTIVE',
    redirectUriStatus: 'registered',
    billingAccountId: 'billing-1',
    maxCapacity: 100,
    currentStores: 0,
    reservedStores: 0,
  };
  const shardsToUse = mockShards.length > 0 ? mockShards : [defaultShard];
  const docMock = {
    set: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({ exists: false }),
  };
  return {
    collection: vi.fn((colName) => {
      if (colName === 'stores') {
        return {
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          get: vi.fn().mockResolvedValue({ empty: !slugExists }),
          doc: vi.fn(() => docMock),
        };
      }
      if (colName === 'infrastructure_shards' || colName === 'shards') {
        return {
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          get: vi.fn().mockResolvedValue({
            empty: false,
            docs: shardsToUse.map((s) => ({
              id: s.id,
              data: () => s,
            })),
          }),
          doc: vi.fn(() => docMock),
        };
      }
      return {
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        get: vi.fn().mockResolvedValue({ empty: true }),
        doc: vi.fn(() => docMock),
        add: vi.fn().mockResolvedValue({ id: 'mock-audit-id' }),
      };
    }),
  };
}

describe('provisionStoreV2 handler', () => {
  let handler: (req: unknown) => Promise<unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('./provisioning');
    // provisionStoreV2 is exported as the handler function (after vi.mock of onCall)
    handler = mod.provisionStoreV2 as unknown as (req: unknown) => Promise<unknown>;
  });

  it('rejects non-admin callers', async () => {
    vi.mocked(getFirestore).mockReturnValue(makeDb() as unknown as ReturnType<typeof getFirestore>);
    await expect(handler(makeRequest(VALID_PAYLOAD, false))).rejects.toThrow(HttpsError);
  });

  it('rejects missing required fields', async () => {
    vi.mocked(getFirestore).mockReturnValue(makeDb() as unknown as ReturnType<typeof getFirestore>);
    await expect(handler(makeRequest({ ...VALID_PAYLOAD, name: '' }))).rejects.toThrow(HttpsError);
  });

  it('rejects invalid slug — too short', async () => {
    vi.mocked(getFirestore).mockReturnValue(makeDb() as unknown as ReturnType<typeof getFirestore>);
    await expect(handler(makeRequest({ ...VALID_PAYLOAD, slug: 'ab' }))).rejects.toThrow(
      HttpsError,
    );
  });

  it('rejects invalid slug — uppercase', async () => {
    vi.mocked(getFirestore).mockReturnValue(makeDb() as unknown as ReturnType<typeof getFirestore>);
    await expect(handler(makeRequest({ ...VALID_PAYLOAD, slug: 'MyStore' }))).rejects.toThrow(
      HttpsError,
    );
  });

  it('rejects invalid slug — starts with hyphen', async () => {
    vi.mocked(getFirestore).mockReturnValue(makeDb() as unknown as ReturnType<typeof getFirestore>);
    await expect(handler(makeRequest({ ...VALID_PAYLOAD, slug: '-mystore' }))).rejects.toThrow(
      HttpsError,
    );
  });

  it('rejects duplicate slug', async () => {
    vi.mocked(getFirestore).mockReturnValue(
      makeDb(true) as unknown as ReturnType<typeof getFirestore>,
    );
    await expect(handler(makeRequest(VALID_PAYLOAD))).rejects.toThrow(HttpsError);
  });

  it('accepts valid slug — lowercase alphanumeric', async () => {
    vi.mocked(getFirestore).mockReturnValue(makeDb() as unknown as ReturnType<typeof getFirestore>);
    const result = await handler(makeRequest({ ...VALID_PAYLOAD, slug: 'mystore123' }));
    expect(result).toHaveProperty('storeId');
    expect(result).toHaveProperty('projectId');
  });

  it('accepts valid slug — with hyphens', async () => {
    vi.mocked(getFirestore).mockReturnValue(makeDb() as unknown as ReturnType<typeof getFirestore>);
    const result = await handler(makeRequest({ ...VALID_PAYLOAD, slug: 'my-store-name' }));
    expect(result).toHaveProperty('storeId');
  });

  it('sets dedicated projectId as vtx-{slug} when dedicatedProject is true', async () => {
    const docMock = {
      set: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ exists: false }),
    };
    const dbMock = {
      collection: vi.fn((colName) => {
        if (colName === 'stores') {
          return {
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            get: vi.fn().mockResolvedValue({ empty: true }),
            doc: vi.fn(() => docMock),
            add: vi.fn().mockResolvedValue({ id: 'mock-audit-id' }),
          };
        }
        return {
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          get: vi.fn().mockResolvedValue({ empty: true }),
          doc: vi.fn(() => docMock),
          add: vi.fn().mockResolvedValue({ id: 'mock-audit-id' }),
        };
      }),
    };
    vi.mocked(getFirestore).mockReturnValue(dbMock as unknown as ReturnType<typeof getFirestore>);

    const result = (await handler(makeRequest({ ...VALID_PAYLOAD, dedicatedProject: true }))) as {
      projectId: string;
    };
    expect(result.projectId).toBe('vtx-my-store');

    expect(docMock.set).toHaveBeenCalled();
    const storeCall = docMock.set.mock.calls.find(
      (call: any[]) => call[0]?.ownerEmail === VALID_PAYLOAD.ownerEmail,
    );
    const savedData = storeCall ? storeCall[0] : docMock.set.mock.calls[0][0];
    expect(savedData.runtimeMode).toBe('dedicated-project');
    expect(savedData.runtimeProjectId).toBe('vtx-my-store');
  });

  it('selects an active shard with available capacity if available', async () => {
    const docMock = {
      set: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ exists: false }),
    };
    const mockShards = [
      {
        id: 'shard-dev-1',
        environment: 'development',
        runtimeMode: 'shared-shard',
        projectId: 'vtx-shard-project-1',
        siteId: 'default',
        status: 'ACTIVE',
        maxCapacity: 100,
        currentStores: 10,
        reservedStores: 2,
        billingAccountId: '01D2F4-C25DF1-489AE9',
        redirectUriStatus: 'registered',
      },
    ];
    const dbMock = {
      collection: vi.fn((colName) => {
        if (colName === 'stores') {
          return {
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            get: vi.fn().mockResolvedValue({ empty: true }),
            doc: vi.fn(() => docMock),
            add: vi.fn().mockResolvedValue({ id: 'mock-audit-id' }),
          };
        }
        if (colName === 'infrastructure_shards') {
          return {
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            get: vi.fn().mockResolvedValue({
              empty: false,
              docs: mockShards.map((s) => ({
                id: s.id,
                data: () => s,
              })),
            }),
            doc: vi.fn(() => docMock),
            add: vi.fn().mockResolvedValue({ id: 'mock-audit-id' }),
          };
        }
        return {
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          get: vi.fn().mockResolvedValue({ empty: true }),
          doc: vi.fn(() => docMock),
          add: vi.fn().mockResolvedValue({ id: 'mock-audit-id' }),
        };
      }),
    };
    vi.mocked(getFirestore).mockReturnValue(dbMock as unknown as ReturnType<typeof getFirestore>);

    const result = (await handler(makeRequest(VALID_PAYLOAD))) as { projectId: string };
    expect(result.projectId).toBe('vtx-shard-project-1');

    expect(docMock.set).toHaveBeenCalled();
    const savedData = docMock.set.mock.calls[0][0] as any;
    expect(savedData.runtimeMode).toBe('shared-shard');
    expect(savedData.shardId).toBe('shard-dev-1');
  });

  it('respects user provided custom subdomain without forcing vtx- prefix', async () => {
    const docMock = {
      set: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ exists: false }),
    };
    const mockShards = [
      {
        id: 'shard-dev-1',
        environment: 'development',
        runtimeMode: 'shared-shard',
        projectId: 'vtx-shard-project-1',
        siteId: 'default',
        status: 'ACTIVE',
        maxCapacity: 100,
        currentStores: 5,
        reservedStores: 1,
        billingAccountId: '01D2F4-C25DF1-489AE9',
        redirectUriStatus: 'registered',
      },
    ];
    const dbMock = {
      collection: vi.fn((colName) => {
        if (colName === 'stores') {
          return {
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            get: vi.fn().mockResolvedValue({ empty: true }),
            doc: vi.fn(() => docMock),
            add: vi.fn().mockResolvedValue({ id: 'mock-audit-id' }),
          };
        }
        if (colName === 'infrastructure_shards') {
          return {
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            get: vi.fn().mockResolvedValue({
              empty: false,
              docs: mockShards.map((s) => ({
                id: s.id,
                data: () => s,
              })),
            }),
            doc: vi.fn(() => docMock),
            add: vi.fn().mockResolvedValue({ id: 'mock-audit-id' }),
          };
        }
        return {
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          get: vi.fn().mockResolvedValue({ empty: true }),
          doc: vi.fn(() => docMock),
          add: vi.fn().mockResolvedValue({ id: 'mock-audit-id' }),
        };
      }),
    };
    vi.mocked(getFirestore).mockReturnValue(dbMock as unknown as ReturnType<typeof getFirestore>);

    await handler(
      makeRequest({
        ...VALID_PAYLOAD,
        subdomain: 'diente-de-leon',
      }),
    );

    expect(docMock.set).toHaveBeenCalled();
    const savedData = docMock.set.mock.calls[0][0] as any;
    expect(savedData.subdomain).toBe('diente-de-leon');
    expect(savedData.runtimeSiteId).toBe('diente-de-leon');
    expect(savedData.siteId).toBe('diente-de-leon');
    expect(savedData.defaultUrl).toBe('https://diente-de-leon.web.app');
  });

  it('rejects store provisioning with a clear error when no active verified shards are available', async () => {
    const docMock = {
      set: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ exists: false }),
    };
    vi.mocked(getFirestore).mockReturnValue({
      collection: vi.fn((colName) => {
        if (colName === 'stores') {
          return {
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            get: vi.fn().mockResolvedValue({ empty: true }),
            doc: vi.fn(() => docMock),
          };
        }
        if (colName === 'infrastructure_shards') {
          return {
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            get: vi.fn().mockResolvedValue({ empty: true }),
            doc: vi.fn(() => docMock),
            add: vi.fn().mockResolvedValue({ id: 'mock-audit-id' }),
          };
        }
        return {
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          get: vi.fn().mockResolvedValue({ empty: true }),
          doc: vi.fn(() => docMock),
          add: vi.fn().mockResolvedValue({ id: 'mock-audit-id' }),
        };
      }),
    } as unknown as ReturnType<typeof getFirestore>);

    await expect(handler(makeRequest(VALID_PAYLOAD))).rejects.toThrow(
      'No hay shards configurados y verificados con capacidad disponible',
    );
  });
});

describe('formatProjectDisplayName', () => {
  it('pads short store names under 4 characters to meet GCP minimum display_name length', () => {
    expect(formatProjectDisplayName('Lit', false)).toBe('Store Lit');
    expect(formatProjectDisplayName('Go', false)).toBe('Store Go');
  });

  it('keeps normal store names unchanged if >= 4 characters', () => {
    expect(formatProjectDisplayName('Tienda Maria', false)).toBe('Tienda Maria');
  });

  it('formats new shard display names cleanly with a minimum length of 4', () => {
    expect(formatProjectDisplayName('Lit', true, 'shard-dev-123')).toBe(
      'Vertex Shard shard-dev-123',
    );
  });

  it('truncates display names longer than 30 characters', () => {
    const longName = 'A'.repeat(50);
    expect(formatProjectDisplayName(longName, false).length).toBe(30);
  });
});

describe('normalizeAuthorizedDomain', () => {
  it('keeps only the hostname expected by Firebase authorizedDomains', () => {
    expect(
      normalizeAuthorizedDomain('https://ecommerce-vertex-dev.firebaseapp.com/__/auth/handler'),
    ).toBe('ecommerce-vertex-dev.firebaseapp.com');
    expect(normalizeAuthorizedDomain(' VTX-STORE.web.app/admin/login ')).toBe('vtx-store.web.app');
  });
});

describe('retryProvisioningV2', () => {
  const retryHandler = retryProvisioningV2 as unknown as (req: {
    auth: { token: Record<string, unknown> };
    data: { storeId: string };
  }) => Promise<{ success: boolean }>;

  it('allows retrying a store in error status and resets failed steps to pending', async () => {
    const updateMock = vi.fn().mockResolvedValue(undefined);
    const storeDoc = {
      exists: true,
      data: () => ({
        id: 'store-error-1',
        status: 'error',
        error: 'Previous error',
        provisioningSteps: {
          createProject: { status: 'done' },
          initFirestore: { status: 'error', error: '403 Forbidden' },
        },
      }),
    };

    vi.mocked(getFirestore).mockReturnValue({
      collection: vi.fn(() => ({
        doc: vi.fn(() => ({
          get: vi.fn().mockResolvedValue(storeDoc),
          update: updateMock,
        })),
      })),
    } as unknown as ReturnType<typeof getFirestore>);

    const res = await retryHandler({
      auth: { token: { platformAdmin: true } },
      data: { storeId: 'store-error-1' },
    });

    expect(res).toEqual({ success: true });
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'provisioning',
        error: null,
        'provisioningSteps.initFirestore.status': 'pending',
      }),
    );
  });

  it('allows retrying a store in provisioning status and resets running steps', async () => {
    const updateMock = vi.fn().mockResolvedValue(undefined);
    const storeDoc = {
      exists: true,
      data: () => ({
        id: 'store-stuck-1',
        status: 'provisioning',
        provisioningSteps: {
          createProject: { status: 'done' },
          initFirestore: { status: 'running', detail: 'Desplegando...' },
        },
      }),
    };

    vi.mocked(getFirestore).mockReturnValue({
      collection: vi.fn(() => ({
        doc: vi.fn(() => ({
          get: vi.fn().mockResolvedValue(storeDoc),
          update: updateMock,
        })),
      })),
    } as unknown as ReturnType<typeof getFirestore>);

    const res = await retryHandler({
      auth: { token: { platformAdmin: true } },
      data: { storeId: 'store-stuck-1' },
    });

    expect(res).toEqual({ success: true });
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'provisioning',
        'provisioningSteps.initFirestore.status': 'pending',
      }),
    );
  });

  it('rejects retrying active stores with precondition error', async () => {
    const storeDoc = {
      exists: true,
      data: () => ({
        id: 'store-active-1',
        status: 'active',
      }),
    };

    vi.mocked(getFirestore).mockReturnValue({
      collection: vi.fn(() => ({
        doc: vi.fn(() => ({
          get: vi.fn().mockResolvedValue(storeDoc),
        })),
      })),
    } as unknown as ReturnType<typeof getFirestore>);

    await expect(
      retryHandler({
        auth: { token: { platformAdmin: true } },
        data: { storeId: 'store-active-1' },
      }),
    ).rejects.toThrow('Solo se pueden reintentar tiendas en estado de error o aprovisionamiento');
  });
});
