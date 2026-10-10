import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { StoresService } from '@core/services/stores';
import type { Store, StoreStatus } from '@core/models/store';
import { deploySourceLabel, isTestDeploySource } from '@core/utils/deploy-source.util';

const STATUS_LABELS: Record<StoreStatus, string> = {
  provisioning: 'Provisionando',
  active: 'Activa',
  suspended: 'Suspendida',
  error: 'Error',
};

@Component({
  selector: 'app-stores-list',
  standalone: true,
  imports: [RouterLink, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-container">
      <!-- Page header -->
      <div class="page-top">
        <div>
          <h1 class="page-title">Tiendas</h1>
          <p class="page-sub">
            {{ stores.stores().length }} tienda{{
              stores.stores().length !== 1 ? 's' : ''
            }}
            registrada{{ stores.stores().length !== 1 ? 's' : '' }}
          </p>
        </div>
        <a routerLink="/stores/new" class="btn-primary">
          <i class="bi bi-plus-lg"></i> Nueva tienda
        </a>
      </div>

      <!-- Pool de shards bajo -->
      @if (stores.poolAlert()) {
        <div class="pool-alert" role="alert">
          <i class="bi bi-exclamation-triangle-fill"></i>
          <div>
            <strong>Pool de shards bajo</strong>
            <p>
              Quedan <strong>{{ stores.poolAlert()!.availableShards }}</strong> shard(s)
              disponible(s) (umbral: {{ stores.poolAlert()!.threshold }}). Provisioná más:
              <code>{{ stores.poolAlert()!.command }}</code>
            </p>
          </div>
        </div>
      }

      <!-- Stats bar -->
      <div class="stats-bar">
        <div class="stat-chip stat-chip--total">
          <span class="stat-chip__count">{{ counts().total }}</span>
          <span class="stat-chip__label">Total</span>
        </div>
        <div class="stat-chip stat-chip--active">
          <span class="stat-chip__count">{{ counts().active }}</span>
          <span class="stat-chip__label">Activas</span>
        </div>
        <div class="stat-chip stat-chip--provisioning">
          <span class="stat-chip__count">{{ counts().provisioning }}</span>
          <span class="stat-chip__label">Provisionando</span>
        </div>
        <div class="stat-chip stat-chip--suspended">
          <span class="stat-chip__count">{{ counts().suspended }}</span>
          <span class="stat-chip__label">Suspendidas</span>
        </div>
        @if (counts().error > 0) {
          <div class="stat-chip stat-chip--error">
            <span class="stat-chip__count">{{ counts().error }}</span>
            <span class="stat-chip__label">Error</span>
          </div>
        }
      </div>

      <!-- Filter bar -->
      <div class="filter-bar">
        <div class="search-wrap">
          <i class="bi bi-search search-wrap__icon"></i>
          <input
            class="search-input"
            type="text"
            placeholder="Buscar por nombre, email o slug…"
            [ngModel]="searchQuery()"
            (ngModelChange)="searchQuery.set($event)"
          />
        </div>
        <div class="filter-controls">
          <select
            class="filter-select"
            [ngModel]="statusFilter()"
            (ngModelChange)="statusFilter.set($event)"
          >
            <option value="all">Todos los estados</option>
            <option value="active">Activa</option>
            <option value="provisioning">Provisionando</option>
            <option value="suspended">Suspendida</option>
            <option value="error">Error</option>
          </select>
          <select class="filter-select" [ngModel]="sortBy()" (ngModelChange)="sortBy.set($event)">
            <option value="created-desc">Más recientes primero</option>
            <option value="created-asc">Más antiguas primero</option>
            <option value="name-asc">Nombre (A-Z)</option>
            <option value="name-desc">Nombre (Z-A)</option>
          </select>
        </div>
      </div>

      <!-- Results -->
      @if (stores.isLoading()) {
        <div class="stores-grid" aria-busy="true">
          @for (s of [1, 2, 3, 4, 5, 6]; track s) {
            <div class="store-card store-card--skeleton">
              <div class="store-card__header">
                <div class="skeleton skeleton--avatar"></div>
                <div class="store-card__title-wrap" style="flex: 1;">
                  <div class="skeleton skeleton--title"></div>
                  <div class="skeleton skeleton--slug mt-1"></div>
                </div>
                <div class="skeleton skeleton--badge"></div>
              </div>
              <div class="store-card__details">
                <div class="skeleton skeleton--url"></div>
                <div class="skeleton skeleton--meta"></div>
              </div>
              <div class="store-card__footer">
                <div class="store-card__tags">
                  <div class="skeleton skeleton--tag"></div>
                  <div class="skeleton skeleton--tag" style="width: 80px;"></div>
                </div>
              </div>
            </div>
          }
        </div>
      } @else if (stores.stores().length === 0) {
        <div class="empty-state">
          <i class="bi bi-shop empty-state__icon"></i>
          <h2>Sin tiendas todavía</h2>
          <p>Creá la primera tienda para empezar.</p>
          <a routerLink="/stores/new" class="btn-primary">Crear tienda</a>
        </div>
      } @else if (filteredStores().length === 0) {
        <div class="empty-state">
          <i class="bi bi-funnel empty-state__icon"></i>
          <h2>Sin resultados</h2>
          <p>No hay tiendas que coincidan con los filtros aplicados.</p>
        </div>
      } @else {
        <div class="stores-grid">
          @for (store of filteredStores(); track store.id) {
            <a [routerLink]="['/stores', store.id]" class="store-card">
              <div class="store-card__header">
                <div class="store-card__avatar">
                  @if (store.logoUrl) {
                    <img [src]="store.logoUrl" [alt]="store.name" class="store-card__logo" />
                  } @else {
                    <span>{{ getStoreInitials(store.name) }}</span>
                  }
                </div>
                <div class="store-card__title-wrap">
                  <h3 class="store-card__name">{{ store.name }}</h3>
                  <span class="store-card__slug">/{{ store.slug }}</span>
                  @if (isTestBuild(store)) {
                    <span
                      class="badge badge--warning"
                      [title]="'Corriendo código de prueba: ' + testSourceLabel(store)"
                    >
                      <i class="bi bi-git"></i> TEST
                    </span>
                  }
                </div>
                <span class="badge {{ storeStatusBadge(store.status) }}">{{
                  statusLabel(store.status)
                }}</span>
              </div>

              <div class="store-card__details">
                <div class="store-card__detail-row">
                  <i class="bi bi-link-45deg"></i>
                  <span class="store-card__url-text">{{ getStoreUrl(store) }}</span>
                </div>
                <div class="store-card__detail-row">
                  <i class="bi bi-envelope"></i>
                  <span>{{ store.ownerEmail }}</span>
                </div>
              </div>

              <div class="store-card__footer">
                <div class="store-card__tags">
                  <span class="store-card__vertical-tag">
                    <i class="bi bi-tag-fill"></i>
                    {{ formatVertical(store.businessVertical || store.verticalId) }}
                  </span>
                  <span
                    class="store-card__sub-tag store-card__sub-tag--{{
                      getSubscriptionBadge(store).style
                    }}"
                  >
                    <i class="bi {{ getSubscriptionBadge(store).icon }}"></i>
                    {{ getSubscriptionBadge(store).label }}
                  </span>
                </div>
                <span class="store-card__arrow">
                  <i class="bi bi-arrow-right"></i>
                </span>
              </div>

              @if (store.status === 'provisioning' || store.status === 'error') {
                <div class="store-card__progress">
                  <div class="store-card__progress-head">
                    <span>{{ provisioningStepLabel(store) }}</span>
                    <span>{{ provisioningPercent(store) }}%</span>
                  </div>
                  <div class="store-card__progress-bar">
                    <div
                      class="store-card__progress-fill"
                      [style.width.%]="provisioningPercent(store)"
                    ></div>
                  </div>
                </div>
              }
            </a>
          }
        </div>
      }
    </div>
  `,
  styleUrl: './stores-list.scss',
})
export class StoresList {
  readonly stores = inject(StoresService);

  searchQuery = signal('');
  statusFilter = signal<StoreStatus | 'all'>('all');
  sortBy = signal<'created-desc' | 'created-asc' | 'name-asc' | 'name-desc'>('created-desc');

  readonly counts = computed(() => {
    const all = this.stores.stores();
    return {
      total: all.length,
      active: all.filter((s) => s.status === 'active').length,
      provisioning: all.filter((s) => s.status === 'provisioning').length,
      suspended: all.filter((s) => s.status === 'suspended').length,
      error: all.filter((s) => s.status === 'error').length,
    };
  });

  readonly filteredStores = computed(() => {
    const q = this.searchQuery().toLowerCase().trim();
    const status = this.statusFilter();
    const sort = this.sortBy();

    const filtered = this.stores.stores().filter((s) => {
      const matchesSearch =
        !q ||
        s.name.toLowerCase().includes(q) ||
        s.ownerEmail.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q);
      const matchesStatus = status === 'all' || s.status === status;
      return matchesSearch && matchesStatus;
    });

    return [...filtered].sort((a, b) => {
      if (sort === 'name-asc') {
        return a.name.localeCompare(b.name);
      }
      if (sort === 'name-desc') {
        return b.name.localeCompare(a.name);
      }
      const getMs = (date: unknown) => {
        if (!date) {
          return 0;
        }
        if (date instanceof Date) {
          return date.getTime();
        }
        const d = date as Record<string, unknown>;
        if (typeof d['toDate'] === 'function') {
          return (d['toDate'] as () => Date)().getTime();
        }
        if (typeof d['seconds'] === 'number') {
          return d['seconds'] * 1000;
        }
        return new Date(date as string | number).getTime() || 0;
      };
      const dateA = getMs(a.createdAt);
      const dateB = getMs(b.createdAt);
      if (sort === 'created-asc') {
        return dateA - dateB;
      }
      // default: created-desc
      return dateB - dateA;
    });
  });

  getStoreUrl(store: Store): string {
    if (window.location.hostname === 'localhost') {
      return `http://localhost:4201/shop?tenantId=${store.slug}`;
    }
    return store.defaultUrl;
  }

  statusLabel(s: Store['status']): string {
    return STATUS_LABELS[s];
  }

  /** ¿La tienda está corriendo un build de prueba (rama/commit) en vez de una release? */
  isTestBuild(store: Store): boolean {
    return isTestDeploySource(store.deploySource) || store.targetChannel === 'test';
  }

  /** Origen legible del build de prueba, para el tooltip del distintivo TEST. */
  testSourceLabel(store: Store): string {
    return deploySourceLabel(store.deploySource, store.templateVersion);
  }

  /** Mapea el estado a una clase de tono existente (badge--success/danger/warning/neutral). */
  storeStatusBadge(s: Store['status']): string {
    switch (s) {
      case 'active':
        return 'badge--success';
      case 'suspended':
      case 'error':
        return 'badge--danger';
      case 'provisioning':
        return 'badge--warning';
      default:
        return 'badge--neutral';
    }
  }

  provisioningPercent(store: Store): number {
    const steps = store.provisioningSteps ?? {};
    const entries = Object.values(steps);
    if (entries.length === 0) {
      return 0;
    }
    const done = entries.filter((step) => step.status === 'done').length;
    return Math.round((done / entries.length) * 100);
  }

  getStoreInitials(name: string): string {
    if (!name) {
      return 'V';
    }
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }

  formatVertical(v?: string): string {
    if (!v) {
      return 'General';
    }
    return v
      .toLowerCase()
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  provisioningStepLabel(store: Store): string {
    const steps = store.provisioningSteps ?? {};
    const ordered = Object.values(steps);
    const running = ordered.find((step) => step.status === 'running');
    if (running) {
      return `En curso: ${running.label}`;
    }

    const failed = ordered.find((step) => step.status === 'error');
    if (failed) {
      return `Falló: ${failed.label}`;
    }

    const pending = ordered.find((step) => step.status === 'pending');
    if (pending) {
      return `Pendiente: ${pending.label}`;
    }

    return 'Provisioning completado, esperando validación final';
  }

  getSubscriptionBadge(store: Store): { label: string; style: string; icon: string } {
    const sub = store.subscription;
    const status = sub?.status;

    if (status === 'complimentary') {
      return { label: 'Cortesía (100% Bonificada)', style: 'complimentary', icon: 'bi-gift-fill' };
    }
    if (status === 'trial') {
      const remaining = sub?.trialDaysRemaining ?? sub?.trialDays;
      const daysText = remaining !== undefined && remaining !== null ? ` (${remaining}d)` : '';
      return { label: `Prueba${daysText}`, style: 'trial', icon: 'bi-hourglass-split' };
    }
    if (status === 'active') {
      const cycle = sub?.billingCycle === 'annual' ? 'Anual' : 'Mensual';
      return { label: `Plan ${cycle}`, style: 'active', icon: 'bi-check-circle-fill' };
    }
    if (status === 'past_due') {
      return {
        label: 'Gracia (+2% mora)',
        style: 'past-due',
        icon: 'bi-exclamation-triangle-fill',
      };
    }
    if (status === 'suspended') {
      return { label: 'Suspendida', style: 'suspended', icon: 'bi-x-circle-fill' };
    }

    return { label: 'Prueba estándar', style: 'trial', icon: 'bi-hourglass-split' };
  }
}
