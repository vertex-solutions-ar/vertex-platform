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
  templateUrl: './stores-list.html',
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
