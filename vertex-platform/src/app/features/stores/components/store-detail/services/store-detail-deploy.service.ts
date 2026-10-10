import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  DeploySourceKind,
  DeploySourceRequest,
  Store,
  StoreDeploySource,
} from '@core/models/store';
import { StoresService } from '@core/services/stores';
import { errorMessage } from '@core/utils/error.util';
import {
  canDeployTestSources,
  deploySourceCommitSuffix,
  deploySourceGitHubUrl,
  deploySourceLabel,
  deploySourceShortLabel,
  isStoreDevEnvironment,
  isTestDeploySource,
  validateDeploySourceValue,
} from '@core/utils/deploy-source.util';
import { StoreDetailOrchestrationService } from './store-detail-orchestration.service';

const SOURCE_KIND_LABELS: Record<DeploySourceKind, string> = {
  release: 'Release',
  branch: 'Rama',
  commit: 'Commit',
};

/**
 * Estado y acciones de la **fuente de despliegue** de una tienda (release vs rama/commit).
 *
 * Vive fuera del componente de detalle porque tiene su propio estado (borrador del
 * selector, confirmación pendiente, opt-in de despliegues de prueba) que antes se perdía
 * al navegar: era el origen de que el panel no reflejara qué estaba desplegado.
 *
 * El componente empuja la tienda actual con `syncStore()`; todo lo demás es derivado.
 */
@Injectable({ providedIn: 'root' })
export class StoreDetailDeployService {
  private storesService = inject(StoresService);
  private orchestration = inject(StoreDetailOrchestrationService);

  readonly branches = this.orchestration.branches;
  readonly defaultBranch = this.orchestration.defaultBranch;
  readonly isLoadingBranches = this.orchestration.isLoadingBranches;
  readonly branchesError = this.orchestration.branchesError;
  readonly sourceKinds: DeploySourceKind[] = ['release', 'branch', 'commit'];

  /** Tienda en foco (la empuja el componente). */
  private readonly store = signal<Store | null>(null);

  readonly isUpdatingAllowTest = signal(false);
  /** Confirmación pendiente antes de pisar el sitio con código de prueba. */
  readonly pendingDeploy = signal<{ request: DeploySourceRequest; isTest: boolean } | null>(null);
  /** La rama se escribe a mano ("Otra rama…") en vez de elegirse del selector. */
  readonly customBranchMode = signal(false);

  /** Funciones de presentación expuestas al template. */
  readonly isStoreDev = isStoreDevEnvironment;
  readonly canTest = canDeployTestSources;
  readonly isTestSource = isTestDeploySource;
  readonly sourceLabel = deploySourceLabel;
  readonly sourceShortLabel = deploySourceShortLabel;
  readonly sourceCommitSuffix = deploySourceCommitSuffix;
  readonly sourceUrl = deploySourceGitHubUrl;

  syncStore(store: Store | null): void {
    this.store.set(store);
  }

  /** Fuente que la tienda realmente está corriendo (o intentando correr). */
  readonly activeDeploySource = computed<StoreDeploySource | null>(() => {
    const store = this.store();
    if (!store) {
      return null;
    }
    if (store.deploySource?.ref) {
      return store.deploySource;
    }
    const pinned = store.templateVersion || store.appVersion;
    return pinned ? { kind: 'release', ref: pinned } : null;
  });

  /** `true` cuando la tienda está corriendo un build de prueba (rama/commit). */
  readonly isRunningTestBuild = computed<boolean>(() => {
    const store = this.store();
    return isTestDeploySource(store?.deploySource) || store?.targetChannel === 'test';
  });

  readonly deployActionState = computed(() =>
    this.orchestration.computeDeployActionState(this.store()),
  );

  /** ¿Hay un despliegue en curso, o la tienda no está en condiciones de desplegar? */
  readonly isBusy = computed<boolean>(() => {
    const store = this.store();
    if (!store) {
      return true;
    }
    return (
      this.orchestration.isStoreUpdating(store.id) ||
      this.deployActionState().status === 'running' ||
      store.status !== 'active'
    );
  });

  /** Borrador del selector (persistido por tienda en el servicio de orquestación). */
  readonly draft = computed(() => {
    const store = this.store();
    if (!store) {
      return { kind: 'release' as DeploySourceKind, release: '', branch: '', commit: '' };
    }
    return this.orchestration.getDeploySourceDraft(store.id, {
      release: store.templateVersion || this.orchestration.latestVersion()?.version || '',
      branch: 'develop',
    });
  });

  readonly kind = computed<DeploySourceKind>(() => this.draft().kind);

  /** Valor actualmente elegido según el tipo activo. */
  readonly value = computed<string>(() => {
    const draft = this.draft();
    return draft[draft.kind] || '';
  });

  /** Error de validación cliente (el backend vuelve a validar igual). */
  readonly validationError = computed<string>(
    () => validateDeploySourceValue(this.kind(), this.value()) ?? '',
  );

  /** Etiqueta del botón de despliegue, según la fuente elegida. */
  readonly actionLabel = computed<string>(() => {
    const value = this.value();
    switch (this.kind()) {
      case 'release': {
        const same = (this.store()?.templateVersion || '').replace(/^v/, '') === value;
        return same ? `Re-desplegar v${value}` : `Actualizar a v${value}`;
      }
      case 'branch':
        return `Desplegar rama ${value}`;
      default:
        return `Desplegar commit ${value.substring(0, 7)}`;
    }
  });

  /** Línea de ayuda sobre la fuente elegida. */
  readonly hint = computed<string>(() => {
    switch (this.kind()) {
      case 'branch':
        return 'Compila directamente el código de esta rama. No crea ni requiere un tag de release.';
      case 'commit':
        return 'Compila un commit puntual. Útil para reproducir exactamente lo que se probó.';
      default:
        return 'Compila una release publicada del template storefront.';
    }
  });

  sourceKindLabel(kind: DeploySourceKind): string {
    return SOURCE_KIND_LABELS[kind];
  }

  /**
   * Un modo de prueba (rama/commit) queda deshabilitado cuando la tienda no lo permite,
   * y todos se bloquean mientras hay un despliegue en curso.
   */
  isModeDisabled(kind: DeploySourceKind): boolean {
    if (this.isBusy()) {
      return true;
    }
    return kind !== 'release' && !this.canTest(this.store());
  }

  setKind(kind: DeploySourceKind): void {
    const store = this.store();
    if (!store || this.isBusy()) {
      return;
    }
    this.orchestration.setDeploySourceDraft(store.id, { kind });
  }

  setValue(value: string): void {
    const store = this.store();
    if (!store) {
      return;
    }
    this.orchestration.setDeploySourceDraft(store.id, { [this.kind()]: value } as {
      release?: string;
      branch?: string;
      commit?: string;
    });
  }

  onReleaseChange(event: Event): void {
    this.setValue((event.target as HTMLSelectElement).value);
  }

  onBranchChange(event: Event): void {
    this.setValue((event.target as HTMLSelectElement).value);
  }

  toggleCustomBranchMode(enabled: boolean): void {
    this.customBranchMode.set(enabled);
    const store = this.store();
    if (!store) {
      return;
    }
    if (enabled) {
      this.orchestration.setDeploySourceDraft(store.id, { branch: '' });
      return;
    }
    const fallback =
      this.branches().find((b) => b.name === 'develop')?.name || this.defaultBranch();
    this.orchestration.setDeploySourceDraft(store.id, { branch: fallback });
  }

  /**
   * Punto de entrada del botón de despliegue.
   *
   * Los despliegues de prueba (rama/commit) pasan por un modal de confirmación: reemplazan
   * lo que ven los clientes por código sin tag. Las releases se despliegan directo.
   */
  async requestDeployment(): Promise<void> {
    const store = this.store();
    const value = this.value().trim();
    if (!store || this.validationError() || this.isBusy()) {
      return;
    }

    const kind = this.kind();

    // "Re-desplegar la release activa" no necesita fuente explícita: deja que la política
    // de la tienda decida (autoUpdate / versión fijada).
    if (kind === 'release') {
      const isActive = (store.templateVersion || '').replace(/^v/, '') === value;
      await this.run(store.id, isActive ? undefined : { kind, value }, false);
      return;
    }

    this.pendingDeploy.set({ request: { kind, value }, isTest: true });
  }

  async confirmPendingDeploy(): Promise<void> {
    const pending = this.pendingDeploy();
    const store = this.store();
    if (!pending || !store) {
      return;
    }
    this.pendingDeploy.set(null);
    await this.run(store.id, pending.request, true);
  }

  cancelPendingDeploy(): void {
    this.pendingDeploy.set(null);
  }

  /** Volver a la release estable fijada por la tienda (sale del canal de prueba). */
  async redeployStable(): Promise<void> {
    const store = this.store();
    if (!store || this.isBusy()) {
      return;
    }
    const pinned = (store.templateVersion || store.appVersion || '').replace(/^v/, '');
    await this.run(store.id, pinned ? { kind: 'release', value: pinned } : undefined, false);
  }

  /** Habilita/deshabilita despliegues de prueba en tiendas que no son development. */
  async toggleAllowTestDeployments(enabled: boolean): Promise<void> {
    const store = this.store();
    if (!store) {
      return;
    }
    this.isUpdatingAllowTest.set(true);
    try {
      await this.storesService.updateStore(store.id, { allowTestDeployments: enabled });
    } catch (err) {
      console.error('Error updating allowTestDeployments:', err);
    } finally {
      this.isUpdatingAllowTest.set(false);
    }
  }

  private async run(
    storeId: string,
    request: DeploySourceRequest | undefined,
    isTest: boolean,
  ): Promise<void> {
    this.orchestration.setDeployDismissed(storeId, false);
    this.orchestration.setUserInitiated(storeId, true, Date.now());
    this.orchestration.setStoreDeploying(storeId, true);
    this.orchestration.setStoreUpdating(storeId, true);
    this.orchestration.setLocalDeployError(storeId, '');
    try {
      await this.storesService.redeployStore(storeId, request);
      if (isTest) {
        this.orchestration.actionSuccess.set('Despliegue de prueba iniciado.');
      }
    } catch (err) {
      this.orchestration.setLocalDeployError(
        storeId,
        errorMessage(err, 'No se pudo iniciar el despliegue.'),
      );
    } finally {
      this.orchestration.setStoreDeploying(storeId, false);
      this.orchestration.setStoreUpdating(storeId, false);
    }
  }
}
