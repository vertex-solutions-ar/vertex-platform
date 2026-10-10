import { Injectable, inject, signal } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { StoresService } from '@core/services/stores';
import { errorMessage } from '@core/utils/error.util';
import type { Store, TemplateVersion, ProvisioningStep } from '@core/models/store';
import type { TemplateBranch } from '@core/models/store';
import type { DeploySourceKind } from '@core/models/store';
import {
  STEP_ORDER,
  IDLE_STATE,
  type ActionProgressState,
  parseDateToMillis,
} from './store-detail.util';

/** Borrador del selector de fuente de despliegue (una entrada por tienda). */
export interface DeploySourceDraft {
  kind: DeploySourceKind;
  release: string;
  branch: string;
  commit: string;
}

const EMPTY_DRAFT: DeploySourceDraft = { kind: 'release', release: '', branch: '', commit: '' };

@Injectable({ providedIn: 'root' })
export class StoreDetailOrchestrationService {
  private storesService = inject(StoresService);
  private fb = inject(FormBuilder);

  readonly isSeeding = signal(false);
  readonly isRetrying = signal(false);
  readonly isDeleting = signal(false);
  readonly isSuspending = signal(false);
  readonly isActivating = signal(false);
  readonly isSaving = signal(false);

  readonly actionError = signal('');
  readonly actionSuccess = signal('');
  readonly saveError = signal('');

  readonly versions = signal<TemplateVersion[]>([]);
  readonly latestVersion = signal<TemplateVersion | null>(null);
  readonly isLoadingVersions = signal(false);
  /** Ramas reales del repositorio storefront, para el selector de fuente de despliegue. */
  readonly branches = signal<TemplateBranch[]>([]);
  readonly defaultBranch = signal<string>('main');
  readonly isLoadingBranches = signal(false);
  readonly branchesError = signal('');
  /**
   * Borrador del selector de fuente por tienda. Vive en el servicio (no en el componente)
   * para que no se pierda al cambiar de pestaña o navegar fuera del detalle.
   */
  readonly deploySourceDrafts = signal<Map<string, DeploySourceDraft>>(
    new Map<string, DeploySourceDraft>(),
  );
  /** Cache de sesión: evita recargar releases en cada visita al detalle. */
  private cachedVersions: TemplateVersion[] | null =
    null; /** Estado de actualización aislado por ID de tienda para evitar contaminación reactiva entre tabs/tiendas */
  readonly updatingStores = signal<Set<string>>(new Set<string>());
  readonly deployingStoreIds = signal<Set<string>>(new Set<string>());
  readonly localDeployErrors = signal<Map<string, string>>(new Map<string, string>());
  readonly dismissedDeployStoreIds = signal<Set<string>>(new Set<string>());
  readonly userInitiatedDeployStoreIds = signal<Set<string>>(new Set<string>());
  readonly deploySessionTimestamps = signal<Map<string, number>>(new Map<string, number>());

  isStoreUpdating(storeId: string): boolean {
    if (!storeId) {
      return false;
    }
    return this.updatingStores().has(storeId) || this.deployingStoreIds().has(storeId);
  }

  setStoreUpdating(storeId: string, updating: boolean): void {
    if (!storeId) {
      return;
    }
    this.updatingStores.update((set) => {
      const next = new Set(set);
      if (updating) {
        next.add(storeId);
      } else {
        next.delete(storeId);
      }
      return next;
    });
  }

  isStoreDeploying(storeId: string): boolean {
    if (!storeId) {
      return false;
    }
    return this.deployingStoreIds().has(storeId);
  }

  setStoreDeploying(storeId: string, deploying: boolean): void {
    if (!storeId) {
      return;
    }
    this.deployingStoreIds.update((set) => {
      const next = new Set(set);
      if (deploying) {
        next.add(storeId);
      } else {
        next.delete(storeId);
      }
      return next;
    });
  }

  getLocalDeployError(storeId: string): string {
    if (!storeId) {
      return '';
    }
    return this.localDeployErrors().get(storeId) || '';
  }

  setLocalDeployError(storeId: string, error: string): void {
    if (!storeId) {
      return;
    }
    this.localDeployErrors.update((map) => {
      const next = new Map(map);
      if (error) {
        next.set(storeId, error);
      } else {
        next.delete(storeId);
      }
      return next;
    });
  }

  isDeployDismissed(storeId: string): boolean {
    if (!storeId) {
      return false;
    }
    return this.dismissedDeployStoreIds().has(storeId);
  }

  setDeployDismissed(storeId: string, dismissed: boolean): void {
    if (!storeId) {
      return;
    }
    this.dismissedDeployStoreIds.update((set) => {
      const next = new Set(set);
      if (dismissed) {
        next.add(storeId);
      } else {
        next.delete(storeId);
      }
      return next;
    });
  }

  hasUserInitiated(storeId: string): boolean {
    if (!storeId) {
      return false;
    }
    return this.userInitiatedDeployStoreIds().has(storeId);
  }

  setUserInitiated(storeId: string, initiated: boolean, timestamp = Date.now()): void {
    if (!storeId) {
      return;
    }
    this.userInitiatedDeployStoreIds.update((set) => {
      const next = new Set(set);
      if (initiated) {
        next.add(storeId);
      } else {
        next.delete(storeId);
      }
      return next;
    });
    this.deploySessionTimestamps.update((map) => {
      const next = new Map(map);
      if (initiated) {
        next.set(storeId, timestamp);
      } else {
        next.delete(storeId);
      }
      return next;
    });
  }

  readonly editForm = this.fb.group({
    name: ['', Validators.required],
    ownerEmail: ['', [Validators.required, Validators.email]],
    logoUrl: [''],
  });

  readonly oauthRedirect = signal<{
    ok: boolean;
    redirectUri: string | null;
    consoleUrl?: string;
  } | null>(null);

  private lastKnownProgressByStore = new Map<string, number>();

  computeDeployActionState(store: Store | null): ActionProgressState {
    if (!store?.id) {
      return IDLE_STATE;
    }
    const storeId = store.id;

    if (this.isDeployDismissed(storeId)) {
      this.lastKnownProgressByStore.delete(storeId);
      return IDLE_STATE;
    }
    const localErr = this.getLocalDeployError(storeId);
    if (localErr) {
      this.lastKnownProgressByStore.delete(storeId);
      return { status: 'error', progress: 100, message: localErr };
    }
    if (store.redeployStatus === 'failed' || store.versionUpdateStatus === 'failed') {
      this.lastKnownProgressByStore.delete(storeId);
      return {
        status: 'error',
        progress: 100,
        message: store.redeployError || '✗ Falló el despliegue del storefront.',
      };
    }
    const isDeployingThis = this.isStoreDeploying(storeId);
    const isGhaRunning =
      store.redeployStatus === 'deploying' || store.versionUpdateStatus === 'updating';

    let lastKnownProgress = this.lastKnownProgressByStore.get(storeId) || 0;

    if (isDeployingThis || isGhaRunning) {
      const updatedAtMillis = parseDateToMillis(
        store.versionUpdateProgress?.updatedAt || store.updatedAt,
      );
      const isStale = updatedAtMillis > 0 && Date.now() - updatedAtMillis > 10 * 60 * 1000;
      if (isStale && !isDeployingThis) {
        this.lastKnownProgressByStore.delete(storeId);
        void this.storesService.resetStoreDeployStatus(store.id);
        return {
          status: 'error',
          progress: 100,
          message: '⚠️ El despliegue anterior excedió el tiempo límite. Podés volver a desplegar.',
        };
      }
      const rawPct = store.versionUpdateProgress?.pct || (isDeployingThis ? 25 : 55);
      lastKnownProgress = Math.max(lastKnownProgress, rawPct);
      this.lastKnownProgressByStore.set(storeId, lastKnownProgress);
      return {
        status: 'running',
        progress: lastKnownProgress,
        message: `🔨 ${store.versionUpdateProgress?.step || 'Compilando en GitHub Actions…'}`,
      };
    }
    if (this.hasUserInitiated(storeId)) {
      const lastDeploy = parseDateToMillis(store.lastDeployedAt);
      const sessionTimestamp = this.deploySessionTimestamps().get(storeId) || 0;
      if (lastDeploy > sessionTimestamp) {
        this.lastKnownProgressByStore.delete(storeId);
        return { status: 'success', progress: 100, message: '✓ Despliegue completado con éxito.' };
      }
      lastKnownProgress = Math.max(lastKnownProgress, 25);
      this.lastKnownProgressByStore.set(storeId, lastKnownProgress);
      return {
        status: 'running',
        progress: lastKnownProgress,
        message: '🔨 Iniciando flujo en GitHub Actions…',
      };
    }
    this.lastKnownProgressByStore.delete(storeId);
    return IDLE_STATE;
  }

  computeProvisioningSnapshot(store: Store | null): {
    total: number;
    done: number;
    percent: number;
    currentLabel: string;
    currentStatus: ProvisioningStep['status'];
  } {
    const steps = store?.provisioningSteps ?? {};
    const orderedKeys = STEP_ORDER.filter((id) => id in steps);
    const ordered = orderedKeys.map((id) => ({ id, ...steps[id] }));
    const total = ordered.length;
    const done = ordered.filter((s) => s.status === 'done').length;
    const current =
      ordered.find((s) => s.status === 'running') ??
      ordered.find((s) => s.status === 'error') ??
      ordered.find((s) => s.status === 'pending') ??
      ordered[ordered.length - 1];
    return {
      total,
      done,
      percent: total > 0 ? Math.round((done / total) * 100) : 0,
      currentLabel: current?.label ?? 'Esperando inicio',
      currentStatus: current?.status ?? 'pending',
    };
  }

  async loadVersions(force = false): Promise<void> {
    if (!force && this.cachedVersions !== null) {
      this.versions.set(this.cachedVersions);
      this.latestVersion.set(
        this.cachedVersions.find((v: TemplateVersion) => v.isLatest) ??
          this.cachedVersions[0] ??
          null,
      );
      return;
    }
    this.isLoadingVersions.set(true);
    if (force) {
      this.cachedVersions = null;
    }
    try {
      const list = await this.storesService.listTemplateVersions(force);
      this.cachedVersions = list;
      this.versions.set(list);
      this.latestVersion.set(list.find((v: TemplateVersion) => v.isLatest) ?? list[0] ?? null);
    } catch {
      this.versions.set([]);
    } finally {
      this.isLoadingVersions.set(false);
    }
  }

  /**
   * Carga las ramas reales del repositorio storefront (una vez, cacheada server-side).
   * Sin esto el selector de rama volvería a ser un input de texto libre.
   */
  async loadTemplateRefs(force = false): Promise<void> {
    if (!force && this.branches().length > 0) {
      return;
    }
    this.isLoadingBranches.set(true);
    this.branchesError.set('');
    try {
      const refs = await this.storesService.listTemplateRefs(force);
      this.branches.set(refs?.branches ?? []);
      this.defaultBranch.set(refs?.defaultBranch || 'main');
    } catch (err) {
      this.branches.set([]);
      this.branchesError.set(
        errorMessage(err, 'No se pudieron listar las ramas del repositorio storefront.'),
      );
    } finally {
      this.isLoadingBranches.set(false);
    }
  }

  /** Borrador del selector para una tienda, con defaults sensatos cuando no existe. */
  getDeploySourceDraft(storeId: string, defaults?: Partial<DeploySourceDraft>): DeploySourceDraft {
    const stored = this.deploySourceDrafts().get(storeId);
    if (stored) {
      return stored;
    }
    const branch =
      defaults?.branch ||
      this.branches().find((b) => b.name === 'develop')?.name ||
      this.defaultBranch();
    return { ...EMPTY_DRAFT, ...defaults, branch: branch || '' };
  }

  setDeploySourceDraft(
    storeId: string,
    patch: Partial<DeploySourceDraft>,
    defaults?: Partial<DeploySourceDraft>,
  ): void {
    if (!storeId) {
      return;
    }
    const current = this.getDeploySourceDraft(storeId, defaults);
    const next = { ...current, ...patch };
    this.deploySourceDrafts.update((map) => {
      const updated = new Map(map);
      updated.set(storeId, next);
      return updated;
    });
  }

  private checkedOAuthStoreId = '';
  async checkOauthRedirect(store: Store | null): Promise<void> {
    if (!store || (store.status !== 'active' && store.status !== 'suspended')) {
      this.oauthRedirect.set(null);
      return;
    }
    if (this.checkedOAuthStoreId === store.id && this.oauthRedirect()) {
      return;
    }
    this.checkedOAuthStoreId = store.id;
    try {
      const fns = getFunctions();
      const check = httpsCallable<
        { storeId: string },
        { ok: boolean; redirectUri: string | null; consoleUrl?: string }
      >(fns, 'checkStoreOAuthRedirect');
      const res = await check({ storeId: store.id });
      this.oauthRedirect.set(res.data);
    } catch {
      this.oauthRedirect.set(null);
    }
  }

  async retryStep(storeId: string): Promise<boolean> {
    this.isRetrying.set(true);
    this.actionError.set('');
    try {
      await this.storesService.retryProvisioning(storeId);
      this.actionSuccess.set('Paso reintentado con éxito.');
      return true;
    } catch (err) {
      this.actionError.set(errorMessage(err) || 'Error al reintentar el paso.');
      return false;
    } finally {
      this.isRetrying.set(false);
    }
  }

  async seedData(
    storeId: string,
    includeMockData = true,
    provisioningMode = 'FULL_DEMO',
    verticalId?: string,
  ): Promise<boolean> {
    this.isSeeding.set(true);
    this.actionError.set('');
    try {
      await this.storesService.seedStore(storeId, includeMockData, provisioningMode, verticalId);
      this.actionSuccess.set('Datos precargados exitosamente.');
      return true;
    } catch (err) {
      this.actionError.set(errorMessage(err) || 'Error al precargar datos.');
      return false;
    } finally {
      this.isSeeding.set(false);
    }
  }

  async suspendStore(storeId: string): Promise<boolean> {
    this.isSuspending.set(true);
    this.actionError.set('');
    try {
      await this.storesService.suspendStore(storeId);
      this.actionSuccess.set('Tienda suspendida con éxito.');
      return true;
    } catch (err) {
      this.actionError.set(errorMessage(err) || 'Error al suspender la tienda.');
      return false;
    } finally {
      this.isSuspending.set(false);
    }
  }

  async activateStore(storeId: string): Promise<boolean> {
    this.isActivating.set(true);
    this.actionError.set('');
    try {
      await this.storesService.activateStore(storeId);
      this.actionSuccess.set('Tienda activada con éxito.');
      return true;
    } catch (err) {
      this.actionError.set(errorMessage(err) || 'Error al activar la tienda.');
      return false;
    } finally {
      this.isActivating.set(false);
    }
  }

  async deleteStore(storeId: string): Promise<boolean> {
    this.isDeleting.set(true);
    this.actionError.set('');
    try {
      await this.storesService.deleteStore(storeId);
      return true;
    } catch (err) {
      this.actionError.set(errorMessage(err) || 'Error al eliminar la tienda.');
      return false;
    } finally {
      this.isDeleting.set(false);
    }
  }

  openEditForm(store: Store | null): void {
    if (!store) {
      return;
    }
    this.editForm.setValue({
      name: store.name,
      ownerEmail: store.ownerEmail,
      logoUrl: store.logoUrl ?? '',
    });
    this.saveError.set('');
  }

  async saveStoreFromForm(storeId: string): Promise<boolean> {
    if (this.editForm.invalid) {
      this.editForm.markAllAsTouched();
      return false;
    }
    this.isSaving.set(true);
    this.saveError.set('');
    try {
      const { name, ownerEmail, logoUrl } = this.editForm.value;
      await this.storesService.updateStore(storeId, {
        name: name!.trim(),
        ownerEmail: ownerEmail!.trim(),
        logoUrl: (logoUrl ?? '').trim() || null,
      });
      return true;
    } catch {
      this.saveError.set('No se pudo guardar los cambios.');
      return false;
    } finally {
      this.isSaving.set(false);
    }
  }
}
