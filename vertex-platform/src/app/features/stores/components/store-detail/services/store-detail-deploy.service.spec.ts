import { TestBed } from '@angular/core/testing';
import { FormBuilder } from '@angular/forms';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StoreDetailDeployService } from './store-detail-deploy.service';
import { StoreDetailOrchestrationService } from './store-detail-orchestration.service';
import { StoresService } from '@core/services/stores';
import type { Store } from '@core/models/store';

const buildStore = (overrides: Partial<Store> = {}): Store =>
  ({
    id: 'store-A',
    name: 'Tienda A',
    slug: 'tienda-a',
    status: 'active',
    templateVersion: '0.9.5',
    ...overrides,
  }) as Store;

describe('StoreDetailDeployService', () => {
  let service: StoreDetailDeployService;
  let storesServiceMock: {
    listTemplateVersions: ReturnType<typeof vi.fn>;
    listTemplateRefs: ReturnType<typeof vi.fn>;
    redeployStore: ReturnType<typeof vi.fn>;
    updateStore: ReturnType<typeof vi.fn>;
    resetStoreDeployStatus: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    storesServiceMock = {
      listTemplateVersions: vi
        .fn()
        .mockResolvedValue([
          { version: '0.9.6', tag: 'v0.9.6', publishedAt: '2026-10-01T00:00:00Z', isLatest: true },
        ]),
      listTemplateRefs: vi.fn().mockResolvedValue({
        defaultBranch: 'main',
        branches: [
          { name: 'main', sha: 'a'.repeat(40), shortSha: 'aaaaaaa', isDefault: true },
          { name: 'develop', sha: 'b'.repeat(40), shortSha: 'bbbbbbb', isDefault: false },
        ],
        releases: [],
      }),
      redeployStore: vi.fn().mockResolvedValue(undefined),
      updateStore: vi.fn().mockResolvedValue(undefined),
      resetStoreDeployStatus: vi.fn().mockResolvedValue(undefined),
    };

    TestBed.configureTestingModule({
      providers: [
        StoreDetailDeployService,
        StoreDetailOrchestrationService,
        FormBuilder,
        { provide: StoresService, useValue: storesServiceMock },
      ],
    });

    service = TestBed.inject(StoreDetailDeployService);
    TestBed.inject(StoreDetailOrchestrationService);
  });

  const sync = async (store: Store | null): Promise<void> => {
    service.syncStore(store);
    await Promise.resolve();
  };

  describe('fuente activa y canal', () => {
    it('cae a la release fijada cuando la tienda no tiene deploySource', async () => {
      await sync(buildStore());
      expect(service.activeDeploySource()).toEqual({ kind: 'release', ref: '0.9.5' });
      expect(service.isRunningTestBuild()).toBe(false);
      expect(service.sourceLabel(service.activeDeploySource(), '0.9.5')).toBe('Release v0.9.5');
    });

    it('refleja una rama de prueba como fuente activa en canal de prueba', async () => {
      await sync(
        buildStore({
          deploySource: { kind: 'branch', ref: 'feat/x', commitSha: 'abc1234def' },
        }),
      );
      expect(service.isRunningTestBuild()).toBe(true);
      expect(service.sourceLabel(service.activeDeploySource(), '0.9.5')).toBe('Rama feat/x');
      expect(service.sourceCommitSuffix(service.activeDeploySource())).toBe(' @ abc1234');
      expect(service.sourceUrl(service.activeDeploySource())).toContain('/tree/feat/x');
    });

    it('marca canal de prueba por targetChannel aunque no haya deploySource', async () => {
      await sync(buildStore({ targetChannel: 'test' }));
      expect(service.isRunningTestBuild()).toBe(true);
    });

    it('sin tienda queda ocupado (no se puede desplegar)', () => {
      expect(service.isBusy()).toBe(true);
    });
  });

  describe('borrador del selector', () => {
    it('default: release fijada y rama develop', async () => {
      await service.branches(); // fuerza la carga previa de ramas
      await TestBed.inject(StoreDetailOrchestrationService).loadTemplateRefs();
      await sync(buildStore());
      expect(service.kind()).toBe('release');
      expect(service.value()).toBe('0.9.5');
      expect(service.draft().branch).toBe('develop');
    });

    it('etiqueta la acción según la fuente elegida', async () => {
      await sync(buildStore());
      expect(service.actionLabel()).toBe('Re-desplegar v0.9.5');

      service.setKind('branch');
      service.setValue('feat/x');
      expect(service.actionLabel()).toBe('Desplegar rama feat/x');
      expect(service.hint()).toContain('No crea ni requiere un tag');

      service.setKind('commit');
      service.setValue('abc1234');
      expect(service.actionLabel()).toBe('Desplegar commit abc1234');
      expect(service.hint()).toContain('commit puntual');
    });

    it('valida el valor de la fuente activa', async () => {
      await sync(buildStore());
      expect(service.validationError()).toBe('');
      service.setKind('branch');
      service.setValue('feat/mi rama');
      expect(service.validationError()).toMatch(/Nombre de rama inválido/);
    });
  });

  describe('guardas de despliegue de prueba', () => {
    it('deshabilita rama/commit en tiendas que no son dev', async () => {
      await sync(buildStore({ environment: 'production' }));
      expect(service.isModeDisabled('release')).toBe(false);
      expect(service.isModeDisabled('branch')).toBe(true);
      expect(service.isModeDisabled('commit')).toBe(true);
    });

    it('habilita rama/commit con opt-in explícito', async () => {
      await sync(buildStore({ environment: 'production', allowTestDeployments: true }));
      expect(service.isModeDisabled('branch')).toBe(false);
    });

    it('bloquea todos los modos mientras hay un despliegue en curso', async () => {
      await sync(buildStore({ environment: 'development' }));
      TestBed.inject(StoreDetailOrchestrationService).setStoreDeploying('store-A', true);
      expect(service.isModeDisabled('release')).toBe(true);
      expect(service.isModeDisabled('branch')).toBe(true);
      expect(service.isBusy()).toBe(true);
    });

    it('toggleAllowTestDeployments persiste el flag', async () => {
      await sync(buildStore({ environment: 'production' }));
      await service.toggleAllowTestDeployments(true);
      expect(storesServiceMock.updateStore).toHaveBeenCalledWith('store-A', {
        allowTestDeployments: true,
      });
      expect(service.isUpdatingAllowTest()).toBe(false);
    });
  });

  describe('despliegue', () => {
    it('re-desplegar la release activa no manda fuente explícita', async () => {
      await sync(buildStore());
      await service.requestDeployment();
      expect(storesServiceMock.redeployStore).toHaveBeenCalledWith('store-A', undefined);
      expect(service.pendingDeploy()).toBeNull();
    });

    it('cambiar de release manda la fuente explícita', async () => {
      await sync(buildStore());
      service.setValue('0.9.6');
      await service.requestDeployment();
      expect(storesServiceMock.redeployStore).toHaveBeenCalledWith('store-A', {
        kind: 'release',
        value: '0.9.6',
      });
      expect(service.pendingDeploy()).toBeNull();
    });

    it('una rama pide confirmación antes de desplegar', async () => {
      await sync(buildStore({ environment: 'development' }));
      service.setKind('branch');
      service.setValue('feat/x');
      await service.requestDeployment();

      expect(storesServiceMock.redeployStore).not.toHaveBeenCalled();
      expect(service.pendingDeploy()).toEqual({
        request: { kind: 'branch', value: 'feat/x' },
        isTest: true,
      });

      await service.confirmPendingDeploy();
      expect(storesServiceMock.redeployStore).toHaveBeenCalledWith('store-A', {
        kind: 'branch',
        value: 'feat/x',
      });
      expect(service.pendingDeploy()).toBeNull();
    });

    it('cancelar la confirmación no despliega', async () => {
      await sync(buildStore({ environment: 'development' }));
      service.setKind('branch');
      service.setValue('feat/x');
      await service.requestDeployment();
      service.cancelPendingDeploy();
      expect(service.pendingDeploy()).toBeNull();
      expect(storesServiceMock.redeployStore).not.toHaveBeenCalled();
    });

    it('no despliega con valor inválido ni con tienda no activa', async () => {
      await sync(buildStore({ environment: 'development' }));
      service.setKind('branch');
      service.setValue('feat/mi rama');
      await service.requestDeployment();
      expect(storesServiceMock.redeployStore).not.toHaveBeenCalled();

      service.setValue('feat/ok');
      await sync(buildStore({ environment: 'development', status: 'suspended' }));
      await service.requestDeployment();
      expect(storesServiceMock.redeployStore).not.toHaveBeenCalled();
    });

    it('redeployStable vuelve a la release fijada', async () => {
      await sync(buildStore({ deploySource: { kind: 'branch', ref: 'feat/x' } }));
      await service.redeployStable();
      expect(storesServiceMock.redeployStore).toHaveBeenCalledWith('store-A', {
        kind: 'release',
        value: '0.9.5',
      });
    });

    it('redeployStable sin versión fijada delega en la política de la tienda', async () => {
      await sync(
        buildStore({ templateVersion: undefined, deploySource: { kind: 'branch', ref: 'x' } }),
      );
      await service.redeployStable();
      expect(storesServiceMock.redeployStore).toHaveBeenCalledWith('store-A', undefined);
    });

    it('un error del backend se refleja como error local del despliegue', async () => {
      storesServiceMock.redeployStore.mockRejectedValueOnce(new Error('La rama "x" no existe'));
      await sync(buildStore());
      service.setValue('0.9.6');
      await service.requestDeployment();
      const orchestration = TestBed.inject(StoreDetailOrchestrationService);
      expect(orchestration.getLocalDeployError('store-A')).toContain('no existe');
      expect(orchestration.isStoreUpdating('store-A')).toBe(false);
    });

    it('marca la sesión como iniciada por el usuario y limpia el estado al terminar', async () => {
      await sync(buildStore());
      service.setValue('0.9.6');
      await service.requestDeployment();
      const orchestration = TestBed.inject(StoreDetailOrchestrationService);
      expect(orchestration.hasUserInitiated('store-A')).toBe(true);
      expect(orchestration.isStoreDeploying('store-A')).toBe(false);
      expect(orchestration.isStoreUpdating('store-A')).toBe(false);
    });
  });

  describe('modo de rama manual', () => {
    it('al activarlo limpia el valor y al desactivarlo vuelve a develop', async () => {
      await sync(buildStore({ environment: 'development' }));
      await TestBed.inject(StoreDetailOrchestrationService).loadTemplateRefs();
      service.toggleCustomBranchMode(true);
      expect(service.customBranchMode()).toBe(true);
      expect(service.draft().branch).toBe('');

      service.toggleCustomBranchMode(false);
      expect(service.customBranchMode()).toBe(false);
      expect(service.draft().branch).toBe('develop');
    });

    it('onReleaseChange / onBranchChange copian el valor elegido', async () => {
      await sync(buildStore());
      service.onReleaseChange({ target: { value: '0.9.6' } } as unknown as Event);
      expect(service.value()).toBe('0.9.6');

      service.setKind('branch');
      service.onBranchChange({ target: { value: 'main' } } as unknown as Event);
      expect(service.value()).toBe('main');
    });

    it('etiquetas de los modos', () => {
      expect(service.sourceKindLabel('release')).toBe('Release');
      expect(service.sourceKindLabel('branch')).toBe('Rama');
      expect(service.sourceKindLabel('commit')).toBe('Commit');
    });
  });
});
