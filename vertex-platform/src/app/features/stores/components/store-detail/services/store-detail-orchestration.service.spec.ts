import { TestBed } from '@angular/core/testing';
import { FormBuilder } from '@angular/forms';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StoreDetailOrchestrationService } from './store-detail-orchestration.service';
import { StoresService } from '@core/services/stores';
import type { Store, TemplateVersion } from '@core/models/store';

describe('StoreDetailOrchestrationService - Store Isolation & Versions', () => {
  let service: StoreDetailOrchestrationService;
  let storesServiceMock: {
    listTemplateVersions: ReturnType<typeof vi.fn>;
    listTemplateRefs: ReturnType<typeof vi.fn>;
    redeployStore: ReturnType<typeof vi.fn>;
    updateStoreVersion: ReturnType<typeof vi.fn>;
    resetStoreDeployStatus: ReturnType<typeof vi.fn>;
    retryProvisioning: ReturnType<typeof vi.fn>;
    seedStore: ReturnType<typeof vi.fn>;
    suspendStore: ReturnType<typeof vi.fn>;
    activateStore: ReturnType<typeof vi.fn>;
    deleteStore: ReturnType<typeof vi.fn>;
    updateStore: ReturnType<typeof vi.fn>;
  };

  const mockRefs = {
    defaultBranch: 'main',
    branches: [
      { name: 'main', sha: '1111111aaaa', shortSha: '1111111', isDefault: true },
      { name: 'develop', sha: '2222222bbbb', shortSha: '2222222', isDefault: false },
    ],
    releases: [],
  };

  const mockVersions: TemplateVersion[] = [
    {
      version: '0.9.1',
      tag: 'v0.9.1',
      publishedAt: '2026-09-11T12:00:00Z',
      isLatest: true,
      schemaVersion: 1,
    },
    {
      version: '0.8.5',
      tag: 'v0.8.5',
      publishedAt: '2026-09-01T12:00:00Z',
      isLatest: false,
      schemaVersion: 1,
    },
  ];

  beforeEach(() => {
    storesServiceMock = {
      listTemplateVersions: vi.fn().mockResolvedValue(mockVersions),
      listTemplateRefs: vi.fn().mockResolvedValue(mockRefs),
      redeployStore: vi.fn().mockResolvedValue(undefined),
      updateStoreVersion: vi.fn().mockResolvedValue(undefined),
      resetStoreDeployStatus: vi.fn().mockResolvedValue(undefined),
      retryProvisioning: vi.fn().mockResolvedValue(undefined),
      seedStore: vi.fn().mockResolvedValue(undefined),
      suspendStore: vi.fn().mockResolvedValue(undefined),
      activateStore: vi.fn().mockResolvedValue(undefined),
      deleteStore: vi.fn().mockResolvedValue(undefined),
      updateStore: vi.fn().mockResolvedValue(undefined),
    };

    TestBed.configureTestingModule({
      providers: [
        StoreDetailOrchestrationService,
        FormBuilder,
        { provide: StoresService, useValue: storesServiceMock },
      ],
    });

    service = TestBed.inject(StoreDetailOrchestrationService);
  });

  describe('Store Isolation (Prevent cross-store contagion)', () => {
    it('mutating update/deploy state on store-A leaves store-B in idle / not updating', () => {
      const storeAId = 'store-A';
      const storeBId = 'store-B';

      expect(service.isStoreUpdating(storeAId)).toBe(false);
      expect(service.isStoreUpdating(storeBId)).toBe(false);
      expect(service.isStoreDeploying(storeAId)).toBe(false);
      expect(service.isStoreDeploying(storeBId)).toBe(false);

      // Act: update store-A
      service.setStoreUpdating(storeAId, true);
      service.setStoreDeploying(storeAId, true);
      service.setUserInitiated(storeAId, true);
      service.setLocalDeployError(storeAId, 'Failed to deploy A');

      // Assert store-A
      expect(service.isStoreUpdating(storeAId)).toBe(true);
      expect(service.isStoreDeploying(storeAId)).toBe(true);
      expect(service.hasUserInitiated(storeAId)).toBe(true);
      expect(service.getLocalDeployError(storeAId)).toBe('Failed to deploy A');

      // Assert store-B remains completely unaffected
      expect(service.isStoreUpdating(storeBId)).toBe(false);
      expect(service.isStoreDeploying(storeBId)).toBe(false);
      expect(service.hasUserInitiated(storeBId)).toBe(false);
      expect(service.getLocalDeployError(storeBId)).toBe('');

      // Test computeDeployActionState isolation
      const storeA: Store = {
        id: storeAId,
        name: 'Tienda A',
        slug: 'tienda-a',
        status: 'active',
        templateVersion: '0.8.5',
      } as Store;

      const storeB: Store = {
        id: storeBId,
        name: 'Tienda B',
        slug: 'tienda-b',
        status: 'active',
        templateVersion: '0.8.5',
      } as Store;

      const stateA = service.computeDeployActionState(storeA);
      const stateB = service.computeDeployActionState(storeB);

      expect(stateA.status).toBe('error');
      expect(stateA.message).toBe('Failed to deploy A');
      expect(stateB.status).toBe('idle');

      // Clear store-A
      service.setStoreUpdating(storeAId, false);
      service.setStoreDeploying(storeAId, false);
      service.setLocalDeployError(storeAId, '');
      expect(service.isStoreUpdating(storeAId)).toBe(false);
    });

    it('handles dismissed deploy progress independently per store', () => {
      service.setDeployDismissed('store-A', true);
      expect(service.isDeployDismissed('store-A')).toBe(true);
      expect(service.isDeployDismissed('store-B')).toBe(false);

      service.setDeployDismissed('store-A', false);
      expect(service.isDeployDismissed('store-A')).toBe(false);
    });

    it('returns false/idle when storeId is empty or null', () => {
      expect(service.isStoreUpdating('')).toBe(false);
      expect(service.isStoreDeploying('')).toBe(false);
      expect(service.getLocalDeployError('')).toBe('');
      expect(service.computeDeployActionState(null).status).toBe('idle');
    });
  });

  describe('Version detection and live refresh', () => {
    it('loadVersions without force uses session cache on subsequent calls', async () => {
      await service.loadVersions(false);
      expect(storesServiceMock.listTemplateVersions).toHaveBeenCalledTimes(1);
      expect(storesServiceMock.listTemplateVersions).toHaveBeenCalledWith(false);
      expect(service.versions()).toHaveLength(2);
      expect(service.latestVersion()?.version).toBe('0.9.1');

      // Second call without force should hit cache
      await service.loadVersions(false);
      expect(storesServiceMock.listTemplateVersions).toHaveBeenCalledTimes(1);
    });

    it('loadVersions with force=true bypasses cache and calls backend with forceRefresh=true', async () => {
      await service.loadVersions(false);
      expect(storesServiceMock.listTemplateVersions).toHaveBeenCalledTimes(1);

      const refreshedVersions: TemplateVersion[] = [
        {
          version: '0.9.2',
          tag: 'v0.9.2',
          publishedAt: '2026-09-11T16:00:00Z',
          isLatest: true,
          schemaVersion: 1,
        },
        ...mockVersions,
      ];
      storesServiceMock.listTemplateVersions.mockResolvedValueOnce(refreshedVersions);

      await service.loadVersions(true);
      expect(storesServiceMock.listTemplateVersions).toHaveBeenCalledTimes(2);
      expect(storesServiceMock.listTemplateVersions).toHaveBeenLastCalledWith(true);
      expect(service.versions()).toHaveLength(3);
      expect(service.latestVersion()?.version).toBe('0.9.2');
    });

    it('handles version loading errors gracefully', async () => {
      storesServiceMock.listTemplateVersions.mockRejectedValueOnce(new Error('Network error'));
      await service.loadVersions(true);
      expect(service.versions()).toEqual([]);
      expect(service.isLoadingVersions()).toBe(false);
    });
  });

  describe('Fuente de despliegue: ramas y borrador del selector', () => {
    it('loadTemplateRefs carga ramas y rama por defecto', async () => {
      await service.loadTemplateRefs();
      expect(storesServiceMock.listTemplateRefs).toHaveBeenCalledWith(false);
      expect(service.branches()).toHaveLength(2);
      expect(service.defaultBranch()).toBe('main');
      expect(service.isLoadingBranches()).toBe(false);
      expect(service.branchesError()).toBe('');
    });

    it('loadTemplateRefs no repite la llamada si ya hay ramas (salvo force)', async () => {
      await service.loadTemplateRefs();
      await service.loadTemplateRefs();
      expect(storesServiceMock.listTemplateRefs).toHaveBeenCalledTimes(1);

      await service.loadTemplateRefs(true);
      expect(storesServiceMock.listTemplateRefs).toHaveBeenCalledTimes(2);
      expect(storesServiceMock.listTemplateRefs).toHaveBeenLastCalledWith(true);
    });

    it('loadTemplateRefs expone un error legible y no rompe el panel', async () => {
      storesServiceMock.listTemplateRefs.mockRejectedValueOnce(new Error('GitHub 502'));
      await service.loadTemplateRefs();
      expect(service.branches()).toEqual([]);
      expect(service.branchesError()).toContain('GitHub 502');
      expect(service.isLoadingBranches()).toBe(false);
    });

    it('el borrador por tienda se conserva y no contagia a otras tiendas', () => {
      service.setDeploySourceDraft('store-A', { kind: 'branch', branch: 'feat/x' });
      service.setDeploySourceDraft('store-B', { kind: 'commit', commit: 'abc1234' });

      expect(service.getDeploySourceDraft('store-A')).toMatchObject({
        kind: 'branch',
        branch: 'feat/x',
      });
      expect(service.getDeploySourceDraft('store-B')).toMatchObject({
        kind: 'commit',
        commit: 'abc1234',
      });
    });

    it('el borrador se fusiona con los defaults al escribir parcialmente', () => {
      service.setDeploySourceDraft('store-A', { kind: 'branch' }, { branch: 'develop' });
      service.setDeploySourceDraft('store-A', { branch: 'feat/y' });
      expect(service.getDeploySourceDraft('store-A')).toMatchObject({
        kind: 'branch',
        branch: 'feat/y',
      });
    });

    it('getDeploySourceDraft prefiere develop, luego la rama por defecto', () => {
      expect(service.getDeploySourceDraft('sin-borrador').branch).toBe('main');
    });

    it('setDeploySourceDraft ignora storeId vacío', () => {
      service.setDeploySourceDraft('', { kind: 'branch' });
      expect(service.deploySourceDrafts().size).toBe(0);
    });
  });
});
