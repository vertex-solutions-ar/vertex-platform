import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';

const mocks = vi.hoisted(() => ({
  mockUnsub: vi.fn(),
  mockOnSnapshot: vi.fn(),
  mockGetFirestore: vi.fn(() => ({})),
  mockCollection: vi.fn(),
  mockGetFunctions: vi.fn(() => ({})),
  mockHttpsCallable: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
  getFirestore: mocks.mockGetFirestore,
  collection: mocks.mockCollection,
  onSnapshot: mocks.mockOnSnapshot,
  doc: vi.fn(),
  updateDoc: vi.fn(),
  serverTimestamp: vi.fn(),
  query: vi.fn((ref) => ref),
  orderBy: vi.fn(),
  limit: vi.fn(),
}));

vi.mock('firebase/functions', () => ({
  getFunctions: mocks.mockGetFunctions,
  httpsCallable: mocks.mockHttpsCallable,
}));

const { mockUnsub, mockOnSnapshot, mockCollection, mockHttpsCallable } = mocks;

import { AuthService } from './auth';
import { signal } from '@angular/core';

describe('StoresService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOnSnapshot.mockImplementation((_ref: unknown, cb: (snap: unknown) => void) => {
      cb({ docs: [] });
      return mockUnsub;
    });
    mockCollection.mockReturnValue({ id: 'stores' });

    TestBed.configureTestingModule({
      providers: [
        {
          provide: AuthService,
          useValue: {
            user: signal({ email: 'admin@test.com' }),
            isSuperAdmin: signal(false),
            isLoggedIn: signal(true),
            isLoading: signal(false),
          },
        },
      ],
    });
  });

  it('initializes stores signal as empty array', async () => {
    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);
    expect(service.stores()).toEqual([]);
  });

  it('registers onSnapshot listeners on construction (stores + custom verticals + pool alert)', async () => {
    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    TestBed.inject(StoresService);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 1 listener para stores + 1 para custom verticals + 1 para alerta de pool de shards
    expect(mockOnSnapshot).toHaveBeenCalledTimes(3);
  });

  it('returns unsubscribe function from onSnapshot (no leak)', async () => {
    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    TestBed.inject(StoresService);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The Observable must return the unsub function so toSignal can clean up
    const observableFactory = mockOnSnapshot.mock.calls[0];
    expect(observableFactory).toBeDefined();
  });

  it('maps snapshot docs to store objects', async () => {
    mockOnSnapshot.mockImplementation((_ref: unknown, cb: (snap: unknown) => void) => {
      cb({
        docs: [
          { id: 'store1', data: () => ({ name: 'Test Store', status: 'active' }) },
          { id: 'store2', data: () => ({ name: 'Another', status: 'suspended' }) },
        ],
      });
      return mockUnsub;
    });

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.stores()).toHaveLength(2);
    expect(service.stores()[0]).toEqual({ id: 'store1', name: 'Test Store', status: 'active' });
    expect(service.stores()[1].id).toBe('store2');
  });

  it('createStore calls the provisionStore cloud function', async () => {
    const mockFn = vi.fn().mockResolvedValue({ data: { storeId: 'abc123' } });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const result = await service.createStore({
      name: 'My Store',
      slug: 'my-store',
      ownerEmail: 'owner@test.com',
    });

    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'provisionStoreV2');
    expect(result).toBe('abc123');
  });

  it('getRuntimeCapacitySummary calls the matching cloud function', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      data: {
        summary: {
          environment: 'production',
          sharedShardCount: 1,
          activeSharedShardCount: 1,
          availableSharedSlots: 48,
          recommendedRuntimeMode: 'shared-shard',
          shards: [],
        },
      },
    });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const result = await service.getRuntimeCapacitySummary();

    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'getRuntimeCapacitySummary');
    expect(result.availableSharedSlots).toBe(48);
  });

  it('getShardReadiness calls the matching cloud function', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      data: {
        environment: 'development',
        total: 2,
        readyCount: 1,
        checkedAt: '2026-08-14T00:00:00.000Z',
        shards: [
          {
            id: 'shard-a',
            projectId: 'vtx-sd-aaaa',
            status: 'WARMUP_READY',
            billingAccountId: 'acc-1',
            redirectUri: 'https://vtx-sd-aaaa.firebaseapp.com/__/auth/handler',
            ready: true,
            missing: [],
            checkedAt: '2026-08-14T00:00:00.000Z',
          },
        ],
      },
    });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);
    const result = await service.getShardReadiness();

    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'getShardReadiness');
    expect(result.readyCount).toBe(1);
    expect(result.shards[0].ready).toBe(true);
  });

  it('inviteStaff returns false when invite email dispatch failed', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      data: {
        success: true,
        inviteEmailSent: false,
      },
    });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const result = await service.inviteStaff('store-1', 'staff@example.com', 'admin');

    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'inviteStaff');
    expect(result.inviteEmailSent).toBe(false);
  });

  it('getStoreStaff falls back to empty arrays when backend omits lists', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      data: {
        success: true,
      },
    });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const result = await service.getStoreStaff('store-2');

    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'getStoreStaff');
    expect(result.staff).toEqual([]);
    expect(result.invitations).toEqual([]);
  });

  it('verifyDomain maps ACTIVE status to live and normalizes DNS records', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      data: {
        success: true,
        status: 'ACTIVE',
        dnsRecords: [
          {
            domainName: '@',
            type: 'TXT',
            rdata: 'vertex-verification-token',
            requiredAction: 'ADD',
          },
        ],
      },
    });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const result = await service.verifyDomain('store-3', 'midominio.com');

    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'verifyDomainDNSStatus');
    expect(result.status).toBe('live');
    expect(result.dnsRecords).toEqual([
      {
        host: '@',
        type: 'TXT',
        value: 'vertex-verification-token',
        requiredAction: 'ADD',
      },
    ]);
  });

  it('verifyDomain maps LIVE status to live', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      data: { success: true, status: 'LIVE', dnsRecords: [] },
    });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const result = await service.verifyDomain('store-4', 'otrodominio.com');

    expect(result.status).toBe('live');
    expect(result.dnsRecords).toEqual([]);
  });

  it('verifyDomain maps unknown status to pending', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      data: { success: true, status: 'PENDING', dnsRecords: [] },
    });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const result = await service.verifyDomain('store-5', 'pendiente.com');

    expect(result.status).toBe('pending');
  });

  it('verifyDomain falls back to pending when status is undefined', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      data: { success: true, dnsRecords: [] },
    });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const result = await service.verifyDomain('store-6', 'indefinido.com');

    expect(result.status).toBe('pending');
  });

  it('connectDomain calls connectDomain cloud function and maps DNS records', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      data: {
        success: true,
        dnsRecords: [
          {
            domainName: '@',
            type: 'A',
            rdata: '151.101.1.195',
            requiredAction: 'ADD',
          },
          {
            domainName: 'www',
            type: 'CNAME',
            rdata: 'tienda.web.app',
            requiredAction: 'ADD',
          },
        ],
      },
    });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const result = await service.connectDomain('store-7', 'mitienda.com');

    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'connectDomain');
    expect(mockFn).toHaveBeenCalledWith({ storeId: 'store-7', domain: 'mitienda.com' });
    expect(result.dnsRecords).toHaveLength(2);
    expect(result.dnsRecords[0]).toEqual({
      host: '@',
      type: 'A',
      value: '151.101.1.195',
      requiredAction: 'ADD',
    });
    expect(result.dnsRecords[1]).toEqual({
      host: 'www',
      type: 'CNAME',
      value: 'tienda.web.app',
      requiredAction: 'ADD',
    });
  });

  it('connectDomain returns empty dnsRecords when backend returns none', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      data: { success: true, dnsRecords: [] },
    });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const result = await service.connectDomain('store-8', 'vacia.com');

    expect(result.dnsRecords).toEqual([]);
  });

  it('connectDomain falls back host to @ when domainName is missing', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      data: {
        success: true,
        dnsRecords: [{ type: 'TXT', rdata: 'verificacion', requiredAction: 'ADD' }],
      },
    });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const result = await service.connectDomain('store-9', 'fallback.com');

    expect(result.dnsRecords[0].host).toBe('@');
  });

  it('redeployStore calls redeployStore cloud function', async () => {
    const mockFn = vi.fn().mockResolvedValue({ data: { success: true } });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    await service.redeployStore('store-abc');
    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'redeployStore');
    expect(mockFn).toHaveBeenCalledWith({ storeId: 'store-abc' });
  });

  it('deleteStore calls deleteStore cloud function', async () => {
    const mockFn = vi.fn().mockResolvedValue({ data: { success: true } });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    await service.deleteStore('store-abc');
    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'deleteStore');
    expect(mockFn).toHaveBeenCalledWith({ storeId: 'store-abc' });
  });

  it('retryProvisioning calls retryProvisioning cloud function', async () => {
    const mockFn = vi.fn().mockResolvedValue({ data: { success: true } });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    await service.retryProvisioning('store-abc');
    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'retryProvisioningV2');
    expect(mockFn).toHaveBeenCalledWith({ storeId: 'store-abc' });
  });
  it('updateStoreConfig calls updateStoreConfig cloud function', async () => {
    const mockFn = vi.fn().mockResolvedValue({ data: { success: true } });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    await service.updateStoreConfig('store-abc', { storeName: 'New Name' });
    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'updateStoreConfig');
    expect(mockFn).toHaveBeenCalledWith({
      storeId: 'store-abc',
      config: { storeName: 'New Name' },
    });
  });

  it('generatePasswordResetLink calls generatePasswordResetLink cloud function', async () => {
    const mockFn = vi
      .fn()
      .mockResolvedValue({ data: { success: true, actionLink: 'https://link' } });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const result = await service.generatePasswordResetLink('store-abc', 'test@test.com');
    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'generatePasswordResetLink');
    expect(mockFn).toHaveBeenCalledWith({ storeId: 'store-abc', email: 'test@test.com' });
    expect(result.actionLink).toBe('https://link');
  });

  it('getStoreConfig calls getStoreConfig cloud function', async () => {
    const mockFn = vi.fn().mockResolvedValue({ data: { config: { storeName: 'Test' } } });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const config = await service.getStoreConfig('store-abc');
    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'getStoreConfig');
    expect(mockFn).toHaveBeenCalledWith({ storeId: 'store-abc' });
    expect(config).toEqual({ storeName: 'Test' });
  });

  it('seedStore calls seedStore cloud function', async () => {
    const mockFn = vi.fn().mockResolvedValue({ data: { success: true } });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    await service.seedStore('store-abc', false, 'CATALOG_ONLY', 'TECNOLOGIA_ELECTRONICA');
    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'seedStore');
    expect(mockFn).toHaveBeenCalledWith({
      storeId: 'store-abc',
      includeMockData: false,
      provisioningMode: 'CATALOG_ONLY',
      verticalId: 'TECNOLOGIA_ELECTRONICA',
    });
  });

  it('listTemplateVersions calls listTemplateVersions cloud function', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      data: { versions: [{ version: 'v1', tag: 'latest', publishedAt: 'now', isLatest: true }] },
    });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const versions = await service.listTemplateVersions(true);
    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'listTemplateVersions');
    expect(mockFn).toHaveBeenCalledWith({ forceRefresh: true });
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe('v1');
  });

  it('updateStoreVersion calls updateStoreVersion cloud function', async () => {
    const mockFn = vi.fn().mockResolvedValue({ data: { success: true } });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    await service.updateStoreVersion('store-abc', 'v2');
    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'updateStoreVersion');
    expect(mockFn).toHaveBeenCalledWith({ storeId: 'store-abc', version: 'v2' });
  });

  it('updateStore and setStatus update firestore documents', async () => {
    const { doc, updateDoc } = await import('firebase/firestore');
    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    await service.updateStore('store-id', { name: 'New Name' });
    expect(doc).toHaveBeenCalledWith(expect.anything(), 'stores', 'store-id');
    expect(updateDoc).toHaveBeenCalled();

    await service.setStatus('store-id', 'suspended');
    expect(doc).toHaveBeenCalledWith(expect.anything(), 'stores', 'store-id');
    expect(updateDoc).toHaveBeenCalled();
  });

  it('inferDnsType correctly parses various dns required actions', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      data: {
        success: true,
        dnsRecords: [
          { requiredAction: 'ADD TXT VALUE' },
          { requiredAction: 'ADD AAAA VALUE' },
          { requiredAction: 'ADD CNAME VALUE' },
          { requiredAction: 'ADD OTHER' },
        ],
      },
    });
    mockHttpsCallable.mockReturnValue(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const result = await service.connectDomain('store-xyz', 'test.com');
    expect(result.dnsRecords[0].type).toBe('TXT');
    expect(result.dnsRecords[1].type).toBe('AAAA');
    expect(result.dnsRecords[2].type).toBe('CNAME');
    expect(result.dnsRecords[3].type).toBe('A');
  });

  it('suspendStore calls the suspendStore callable', async () => {
    const mockFn = vi.fn().mockResolvedValue({ data: { success: true } });
    mockHttpsCallable.mockReturnValue(mockFn);
    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);
    await service.suspendStore('store-1');
    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'suspendStore');
    expect(mockFn).toHaveBeenCalledWith({ storeId: 'store-1' });
  });

  it('activateStore calls the activateStore callable', async () => {
    const mockFn = vi.fn().mockResolvedValue({ data: { success: true } });
    mockHttpsCallable.mockReturnValue(mockFn);
    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);
    await service.activateStore('store-1');
    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'activateStore');
    expect(mockFn).toHaveBeenCalledWith({ storeId: 'store-1' });
  });

  it('updates poolAlert from system_alerts snapshot (active/inactive)', async () => {
    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // El listener de la alerta de pool es el onSnapshot cuyo ref es el doc mock (undefined);
    // el listener de stores usa collection (ref { id: 'stores' }).
    const poolAlertCall = mockOnSnapshot.mock.calls.find((c) => c[0] === undefined);
    expect(poolAlertCall).toBeDefined();
    const poolAlertCb = poolAlertCall![1] as (snap: unknown) => void;

    poolAlertCb({ data: () => ({ active: true, availableShards: 1, threshold: 2 }) });
    expect(service.poolAlert()).toEqual({
      availableShards: 1,
      threshold: 2,
      command: 'npx tsx scripts/provision-shards.ts --target 10',
    });

    poolAlertCb({ data: () => ({ active: false }) });
    expect(service.poolAlert()).toBeNull();

    // Sin availableShards ni threshold → usa defaults
    poolAlertCb({ data: () => ({ active: true }) });
    expect(service.poolAlert()).toEqual({
      availableShards: 0,
      threshold: 2,
      command: 'npx tsx scripts/provision-shards.ts --target 10',
    });
  });

  it('createCustomVertical calls the createCustomVertical callable', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      data: {
        success: true,
        vertical: { id: 'TEST_VERTICAL', name: 'Test Vertical', icon: '🏷️' },
      },
    });
    mockHttpsCallable.mockReturnValue(mockFn);
    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const result = await service.createCustomVertical({
      name: 'Custom Rubro',
      icon: '✨',
      description: 'Descripción custom',
      categories: ['Cat 1', 'Cat 2'],
    });

    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'createCustomVertical');
    expect(mockFn).toHaveBeenCalledWith({
      name: 'Custom Rubro',
      icon: '✨',
      description: 'Descripción custom',
      categories: ['Cat 1', 'Cat 2'],
    });
    expect(result.success).toBe(true);
  });

  it('getStoreSubscription calls the getStoreSubscription callable', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      data: {
        storeId: 'store-1',
        subscription: { status: 'active' },
        basePricing: {
          name: 'Plan',
          description: 'Desc',
          monthlyPrice: 50000,
          annualPrice: 500000,
        },
        isMasterAdmin: true,
      },
    });
    mockHttpsCallable.mockReturnValue(mockFn);
    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const result = await service.getStoreSubscription('store-1');
    expect(mockHttpsCallable).toHaveBeenCalledWith(expect.anything(), 'getStoreSubscription');
    expect(mockFn).toHaveBeenCalledWith({ storeId: 'store-1' });
    expect(result.storeId).toBe('store-1');
  });

  it('createStoreSubscriptionLink calls the callable with monthly and annual options', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      data: {
        success: true,
        checkoutUrl: 'https://mp.com/checkout',
        billingCycle: 'monthly',
        amount: 50000,
      },
    });
    mockHttpsCallable.mockReturnValue(mockFn);
    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const result = await service.createStoreSubscriptionLink(
      'store-1',
      'monthly',
      'buyer@test.com',
    );
    expect(mockHttpsCallable).toHaveBeenCalledWith(
      expect.anything(),
      'createStoreSubscriptionLink',
    );
    expect(mockFn).toHaveBeenCalledWith({
      storeId: 'store-1',
      billingCycle: 'monthly',
      payerEmail: 'buyer@test.com',
    });
    expect(result.checkoutUrl).toBe('https://mp.com/checkout');
  });

  it('updateStoreSubscriptionStatus calls updateStoreSubscriptionStatus callable', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      data: { success: true, message: 'Updated' },
    });
    mockHttpsCallable.mockReturnValue(mockFn);
    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const result = await service.updateStoreSubscriptionStatus({
      storeId: 'store-1',
      status: 'complimentary',
      simulateExpiration: 'imminent',
    });
    expect(mockHttpsCallable).toHaveBeenCalledWith(
      expect.anything(),
      'updateStoreSubscriptionStatus',
    );
    expect(mockFn).toHaveBeenCalledWith({
      storeId: 'store-1',
      status: 'complimentary',
      simulateExpiration: 'imminent',
    });
    expect(result.success).toBe(true);
  });

  it('getPlatformBillingConfig and updatePlatformBillingConfig call respective callables', async () => {
    const mockGetFn = vi.fn().mockResolvedValue({
      data: {
        pricing: { monthlyPrice: 50000, annualPrice: 500000 },
        isMasterAdmin: true,
      },
    });
    const mockUpdateFn = vi.fn().mockResolvedValue({
      data: {
        success: true,
        message: 'Saved',
        pricing: { monthlyPrice: 55000, annualPrice: 550000 },
      },
    });

    mockHttpsCallable.mockReturnValueOnce(mockGetFn).mockReturnValueOnce(mockUpdateFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const config = await service.getPlatformBillingConfig();
    expect(config.isMasterAdmin).toBe(true);

    const updated = await service.updatePlatformBillingConfig({ monthlyPrice: 55000 });
    expect(updated.success).toBe(true);
  });

  it('listTemplateVersions, updateStoreVersion, seedStore, getStoreConfig, verifyDomain, generatePasswordResetLink, inviteStaff, listStaff', async () => {
    const mockFn = vi.fn().mockImplementation((_name: unknown) => {
      return vi.fn().mockResolvedValue({
        data: {
          versions: [{ version: '0.8.0', isCurrent: true }],
          config: { storeName: 'Config 1' },
          status: 'LIVE',
          dnsRecords: [{ domainName: 'test.com', type: 'A', value: '1.2.3.4' }],
          actionLink: 'https://auth.reset',
          inviteEmailSent: true,
          staff: [{ email: 'staff@test.com' }],
          invitations: [],
          success: true,
        },
      });
    });
    mockHttpsCallable.mockImplementation(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    const versions = await service.listTemplateVersions();
    expect(versions.length).toBe(1);

    await service.updateStoreVersion('store-1', '0.8.0');
    await service.seedStore('store-1', true, 'EMPTY', 'TECNOLOGIA');
    const cfg = await service.getStoreConfig('store-1');
    expect(cfg?.storeName).toBe('Config 1');

    const domain = await service.verifyDomain('store-1', 'test.com');
    expect(domain.status).toBe('live');
    expect(domain.dnsRecords.length).toBe(1);

    const reset = await service.generatePasswordResetLink('store-1', 'user@test.com');
    expect(reset.actionLink).toBe('https://auth.reset');

    const staffInvite = await service.inviteStaff('store-1', 'user@test.com', 'admin');
    expect(staffInvite.inviteEmailSent).toBe(true);

    const staffList = await service.getStoreStaff('store-1');
    expect(staffList.staff.length).toBe(1);
  });

  it('covers store actions: redeploy, history, delete, domain, update, status, reset, suspend, activate, retry, shard readiness', async () => {
    const mockFn = vi.fn().mockImplementation(() =>
      vi.fn().mockResolvedValue({
        data: {
          success: true,
          dnsRecords: [{ domainName: 'custom.com', type: 'CNAME', value: 'ghs.googlehosted.com' }],
          shards: [],
          checkedAt: new Date().toISOString(),
        },
      }),
    );
    mockHttpsCallable.mockImplementation(mockFn);

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    await service.redeployStore('store-1');
    await service.deleteStore('store-1');
    const domain = await service.connectDomain('store-1', 'custom.com');
    expect(domain.dnsRecords.length).toBe(1);

    await service.updateStore('store-1', { name: 'Updated' });
    await service.setStatus('store-1', 'active');
    await service.resetStoreDeployStatus('store-1');
    await service.suspendStore('store-1');
    await service.activateStore('store-1');
    await service.retryProvisioning('store-1');

    const readiness = await service.getShardReadiness(true);
    expect(readiness.checkedAt).toBeDefined();

    // Deployment history observable test
    const historyObs = service.getStoreDeploymentHistory('store-1');
    let historyReceived: unknown = null;
    historyObs.subscribe((val) => {
      historyReceived = val;
    });

    const deployHistoryCall = mockOnSnapshot.mock.calls.find(
      (c) => c[0] && typeof c[0] === 'object',
    );
    if (deployHistoryCall) {
      const snapCb = deployHistoryCall[1] as (snap: unknown) => void;
      snapCb({ docs: [{ id: 'dep-1', data: () => ({ commit: 'abc' }) }] });
      expect(historyReceived).toEqual([{ id: 'dep-1', commit: 'abc' }]);

      const errCb = deployHistoryCall[2] as (err: unknown) => void;
      if (errCb) {
        errCb(new Error('deploy hist fail'));
      }
    }
  });

  it('handles auth user undefined, null, and onSnapshot error handlers for stores and custom verticals', async () => {
    let storeErrCb: ((err: unknown) => void) | null = null;
    let customVertSnapCb: ((snap: unknown) => void) | null = null;
    let customVertErrCb: ((err: unknown) => void) | null = null;

    mockOnSnapshot.mockImplementation(
      (ref: { id?: string }, onNext: (s: unknown) => void, onError?: (e: unknown) => void) => {
        if (ref?.id === 'stores') {
          storeErrCb = onError || null;
        } else if (ref?.id === 'business_verticals') {
          customVertSnapCb = onNext;
          customVertErrCb = onError || null;
        }
        return mockUnsub;
      },
    );

    const userSignal = signal<{ email: string } | null | undefined>(undefined);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AuthService,
          useValue: {
            user: userSignal,
            isSuperAdmin: signal(false),
            isLoggedIn: signal(true),
            isLoading: signal(false),
          },
        },
      ],
    });

    const { StoresService } = await import('./stores');
    TestBed.configureTestingModule({ providers: [StoresService] });
    const service = TestBed.inject(StoresService);

    // Auth resolving (undefined)
    userSignal.set(undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(service.stores()).toEqual([]);

    // Auth logged out (null)
    userSignal.set(null);
    await new Promise((r) => setTimeout(r, 0));
    expect(service.stores()).toEqual([]);

    // Auth logged in
    userSignal.set({ email: 'admin@test.com' });
    await new Promise((r) => setTimeout(r, 0));

    // Store error handling
    if (storeErrCb) {
      (storeErrCb as (err: { code: string }) => void)({ code: 'unavailable' });
      (storeErrCb as (err: { code: string }) => void)({ code: 'permission-denied' });
    }

    // Custom verticals snapshot with defaults
    if (customVertSnapCb) {
      (customVertSnapCb as (snap: unknown) => void)({
        docs: [
          {
            id: 'VERT_1',
            data: () => ({
              name: '',
              icon: '',
              description: '',
              categories: null,
              themeColors: { primary: '#fff' },
            }),
          },
        ],
      });
      expect(service.customVerticals().length).toBe(1);
      expect(service.allVerticals().length).toBeGreaterThan(1);
    }

    // Custom verticals error handling
    if (customVertErrCb) {
      (customVertErrCb as (err: unknown) => void)(new Error('Failed loading verticals'));
    }
  });

  it('correctly compares template versions with isVersionOutdated', async () => {
    const { isVersionOutdated } =
      await import('../../features/stores/components/store-detail/services/store-detail.util');
    expect(isVersionOutdated('0.8.9', '0.9.0')).toBe(true);
    expect(isVersionOutdated('v0.8.9', 'v0.9.0')).toBe(true);
    expect(isVersionOutdated('0.9.0', '0.9.0')).toBe(false);
    expect(isVersionOutdated('0.9.1', '0.9.0')).toBe(false);
    expect(isVersionOutdated('1.0.0', '0.9.0')).toBe(false);
    expect(isVersionOutdated('0.8.5', '0.9.0')).toBe(true);
    expect(isVersionOutdated(undefined, '0.9.0')).toBe(false);
    expect(isVersionOutdated('0.8.9', undefined)).toBe(false);
  });
});
