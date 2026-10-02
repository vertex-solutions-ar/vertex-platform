import { Injectable, inject, signal, computed } from '@angular/core';
import {
  getFirestore,
  collection,
  onSnapshot,
  doc,
  updateDoc,
  serverTimestamp,
  query,
  orderBy,
  limit,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { Observable, switchMap, of } from 'rxjs';
import { AuthService } from './auth';

import type {
  Store,
  CreateStorePayload,
  StoreConfig,
  StaffMember,
  PendingInvitation,
  TemplateVersion,
  PricingOverride,
} from '../models/store';
import type {
  DnsRecord,
  RawDnsRecord,
  RuntimeShardCapacity,
  RuntimeCapacitySummary,
  ShardReadinessReason,
  ShardReadiness,
  ShardReadinessReport,
} from '../models/shard-capacity';
import { normalizeDomainStatus, mapDnsRecords } from '../models/shard-capacity';
import {
  PLATFORM_BUSINESS_VERTICALS,
  type VerticalOption,
  type CreateCustomVerticalPayload,
} from '../constants/business-verticals.constants';

export type {
  DnsRecord,
  RuntimeShardCapacity,
  RuntimeCapacitySummary,
  ShardReadinessReason,
  ShardReadiness,
  ShardReadinessReport,
};

@Injectable({ providedIn: 'root' })
export class StoresService {
  private db = getFirestore();
  private fns = getFunctions();
  private storesRef = collection(this.db, 'stores');
  private customVerticalsRef = collection(this.db, 'business_verticals');
  private authService = inject(AuthService);

  readonly stores = toSignal(
    toObservable(this.authService.user).pipe(
      switchMap((u) => {
        if (u === undefined) {
          // Auth is still resolving. Keep isLoading true.
          return of([]);
        }
        if (u === null) {
          this.isLoading.set(false);
          return of([]);
        }
        return new Observable<Store[]>((subscriber) => {
          const unsub = onSnapshot(
            this.storesRef,
            (snap) => {
              this.isLoading.set(false);
              subscriber.next(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Store));
            },
            (error) => {
              // Firestore SDK handles reconnection internally; this handler covers
              // persistent failures. The SDK logs transport-level noise independently.
              if (error?.code === 'unavailable' || error?.code === 'cancelled') {
                console.warn('[StoresService] Firestore temporarily unavailable, retrying...');
              } else {
                console.error(
                  '[StoresService] Firestore subscription error:',
                  error?.code || error,
                );
              }
              this.isLoading.set(false);
              subscriber.next([]);
            },
          );
          return unsub;
        });
      }),
    ),
    { initialValue: [] },
  );

  readonly customVerticals = toSignal(
    toObservable(this.authService.user).pipe(
      switchMap((u) => {
        if (!u) {
          return of([]);
        }
        return new Observable<VerticalOption[]>((subscriber) => {
          const unsub = onSnapshot(
            this.customVerticalsRef,
            (snap) => {
              const list: VerticalOption[] = snap.docs.map((d) => {
                const data = d.data();
                return {
                  id: d.id,
                  icon: data['icon'] || '🏷️',
                  name: data['name'] || d.id,
                  description: data['description'] || '',
                  isCustom: true,
                  categories: data['categories'] || [],
                  themeColors: data['themeColors'],
                };
              });
              subscriber.next(list);
            },
            (err) => {
              console.warn('[StoresService] Error loading custom verticals:', err);
              subscriber.next([]);
            },
          );
          return unsub;
        });
      }),
    ),
    { initialValue: [] },
  );

  readonly allVerticals = computed<VerticalOption[]>(() => {
    const custom = this.customVerticals() || [];
    return [...PLATFORM_BUSINESS_VERTICALS, ...custom];
  });

  /** True hasta que llega el primer snapshot de tiendas (para skeletons/loadings). */
  readonly isLoading = signal(true);

  /** Alerta de pool de shards bajo (in-app) — leída de system_alerts/pool_low_{env}. */
  readonly poolAlert = signal<{
    availableShards: number;
    threshold: number;
    command: string;
  } | null>(null);

  private readonly poolAlertUnsub = (() => {
    try {
      // Solo suscribirse si la app de Firebase está inicializada (los tests unitarios
      // sin initializeApp no deben romper la construcción del servicio).
      const env = this.authService.user()?.uid
        ? this.db.app?.options?.projectId === 'vertex-platform-app'
          ? 'prod'
          : 'dev'
        : 'dev';
      return onSnapshot(doc(this.db, `system_alerts/pool_low_${env}`), (snap) => {
        const data = snap.data() as
          | {
              active?: boolean;
              availableShards?: number;
              threshold?: number;
              command?: string;
            }
          | undefined;
        this.poolAlert.set(
          data?.active
            ? {
                availableShards: data.availableShards ?? 0,
                threshold: data.threshold ?? 2,
                command: data.command ?? 'npx tsx scripts/provision-shards.ts --target 10',
              }
            : null,
        );
      });
    } catch {
      return () => {};
    }
  })();

  async createStore(payload: CreateStorePayload): Promise<string> {
    const fn = httpsCallable<CreateStorePayload, { storeId: string }>(this.fns, 'provisionStoreV2');
    const result = await fn(payload);
    return result.data.storeId;
  }

  async getRuntimeCapacitySummary(): Promise<RuntimeCapacitySummary> {
    const fn = httpsCallable<
      Record<string, never>,
      { summary?: RuntimeCapacitySummary } & RuntimeCapacitySummary
    >(this.fns, 'getRuntimeCapacitySummary');
    const result = await fn({});
    return result.data.summary ?? (result.data as RuntimeCapacitySummary);
  }

  async getShardReadiness(forceRefresh = false): Promise<ShardReadinessReport> {
    const fn = httpsCallable<{ forceRefresh?: boolean }, ShardReadinessReport>(
      this.fns,
      'getShardReadiness',
    );
    const result = await fn({ forceRefresh });
    return result.data;
  }

  async redeployStore(storeId: string): Promise<void> {
    const fn = httpsCallable<{ storeId: string }, { success: boolean }>(this.fns, 'redeployStore');
    await fn({ storeId });
  }

  getStoreDeploymentHistory(storeId: string): Observable<Record<string, unknown>[]> {
    const deploysRef = collection(this.db, 'stores', storeId, 'deploys');
    const q = query(deploysRef, orderBy('timestamp', 'desc'), limit(50));
    return new Observable<Record<string, unknown>[]>((subscriber) => {
      return onSnapshot(
        q,
        (snap) => {
          subscriber.next(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        },
        (error) => {
          console.warn('[StoresService] error fetching deploy history:', error);
          subscriber.next([]);
        },
      );
    });
  }

  async deleteStore(storeId: string): Promise<void> {
    const fn = httpsCallable<{ storeId: string }, { success: boolean }>(this.fns, 'deleteStore');
    await fn({ storeId });
  }

  async connectDomain(storeId: string, domain: string): Promise<{ dnsRecords: DnsRecord[] }> {
    const fn = httpsCallable<
      { storeId: string; domain: string },
      { success: boolean; dnsRecords: RawDnsRecord[] }
    >(this.fns, 'connectDomain');
    // Sanitización determinista en el cliente (misma regla que el backend).
    const clean = this.sanitizeDomain(domain);
    const result = await fn({ storeId, domain: clean });
    return { dnsRecords: mapDnsRecords(result.data.dnsRecords) };
  }

  /** Normaliza un dominio ingresado por el usuario (protocolo/www/puertos/paths). */
  private sanitizeDomain(raw: string): string {
    let d = String(raw ?? '')
      .trim()
      .toLowerCase();
    d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    d = (d.split(/[/?#]/)[0] || d).trim();
    d = d.replace(/:\d{1,5}$/, '');
    d = d.replace(/^www\./, '');
    return d.replace(/\.+$/, '').trim();
  }

  /**
   * pingMercadoPagoConnection — health check en vivo contra Mercado Pago.
   * Devuelve el titular de la cuenta (nickname, email, collector) o el error de MP.
   */
  async pingMercadoPagoConnection(accessToken: string): Promise<MpPingResponse> {
    const fn = httpsCallable<{ accessToken: string }, MpPingResponse>(
      this.fns,
      'pingMercadoPagoConnection',
    );
    const result = await fn({ accessToken });
    return result.data;
  }

  /** Estado en vivo del dominio (getDomainStatus callable). */
  async getDomainStatus(storeId: string, domain: string): Promise<DomainStatusResponse> {
    const fn = httpsCallable<{ storeId: string; domain: string }, DomainStatusResponse>(
      this.fns,
      'getDomainStatus',
    );
    const result = await fn({ storeId, domain });
    return result.data;
  }

  /** Desvincula el dominio (disconnectDomain callable). */
  async disconnectDomain(storeId: string, domain: string): Promise<{ success: boolean }> {
    const fn = httpsCallable<{ storeId: string; domain: string }, { success: boolean }>(
      this.fns,
      'disconnectDomain',
    );
    const result = await fn({ storeId, domain });
    return result.data;
  }

  /** Borra un cliente o pedido puntual (super admin). */
  async deleteStoreDataItem(
    storeId: string,
    kind: 'client' | 'order',
    reference: string,
  ): Promise<{ success: boolean; message: string }> {
    const fn = httpsCallable<
      { storeId: string; kind: 'client' | 'order'; reference: string },
      { success: boolean; message: string }
    >(this.fns, 'deleteStoreDataItem');
    const result = await fn({ storeId, kind, reference });
    return result.data;
  }

  /** Chequea disponibilidad de un subdominio .web.app. */
  async checkSubdomainAvailability(
    candidate: string,
    storeId?: string,
  ): Promise<{
    available: boolean;
    sanitized: string;
    suggestions?: string[];
    reason?: string;
    message?: string;
  }> {
    const fn = httpsCallable<
      { candidate: string; storeId?: string },
      {
        available: boolean;
        sanitized: string;
        suggestions?: string[];
        reason?: string;
        message?: string;
      }
    >(this.fns, 'checkSubdomainAvailability');
    const result = await fn({ candidate, storeId });
    return result.data;
  }

  /** Cambia la dirección gratuita .web.app de la tienda. */
  async updateStoreSubdomain(
    storeId: string,
    newSubdomain: string,
  ): Promise<{ success: boolean; subdomain: string; url?: string }> {
    const fn = httpsCallable<
      { storeId: string; newSubdomain: string },
      { success: boolean; subdomain: string; url?: string }
    >(this.fns, 'updateStoreSubdomain');
    const result = await fn({ storeId, newSubdomain });
    return result.data;
  }

  /** Purga super-admin de datos de prueba (purgeStoreData callable). */
  async purgeStoreData(
    storeId: string,
    opts: {
      deleteClients?: boolean;
      deleteOrders?: boolean;
      deleteCatalog?: boolean;
      deleteContent?: boolean;
    },
  ): Promise<PurgeStoreDataResult> {
    const fn = httpsCallable<{ storeId: string } & typeof opts, PurgeStoreDataResult>(
      this.fns,
      'purgeStoreData',
    );
    const result = await fn({ storeId, ...opts });
    return result.data;
  }

  /** Logs por tienda (getStoreLogs callable). */
  async getStoreLogs(
    storeId: string,
    opts: {
      severity?: string;
      query?: string;
      sinceMinutes?: number;
      startDate?: string;
      endDate?: string;
      source?: 'orders' | 'system' | 'cloud';
      limit?: number;
    } = {},
  ): Promise<StoreLogsResponse> {
    const fn = httpsCallable<{ storeId: string } & typeof opts, StoreLogsResponse>(
      this.fns,
      'getStoreLogs',
    );
    const result = await fn({ storeId, ...opts });
    return result.data;
  }

  /** Auto-heal de shards (triggerHealShards callable). */
  async triggerHealShards(): Promise<HealShardsReport> {
    const fn = httpsCallable<Record<string, never>, HealShardsReport>(
      this.fns,
      'triggerHealShards',
    );
    const result = await fn({});
    return result.data;
  }

  /** Consulta el catálogo oficial de precios de planes en system_config/billing */
  async getGlobalPlansPricing(): Promise<{
    monthlyPrice: number;
    annualPrice: number;
    name?: string;
    description?: string;
  }> {
    const fn = httpsCallable<
      Record<string, never>,
      {
        success: boolean;
        pricing: {
          monthlyPrice: number;
          annualPrice: number;
          name?: string;
          description?: string;
        };
      }
    >(this.fns, 'getGlobalPlansPricing');
    const result = await fn({});
    return result.data.pricing;
  }

  /** Actualiza las tarifas base de los planes SaaS (Super Admin) */
  async updateGlobalPlansPricing(payload: {
    monthlyPrice?: number;
    annualPrice?: number;
    name?: string;
    description?: string;
  }): Promise<{
    monthlyPrice: number;
    annualPrice: number;
    name?: string;
    description?: string;
  }> {
    const fn = httpsCallable<
      typeof payload,
      {
        success: boolean;
        message: string;
        pricing: {
          monthlyPrice: number;
          annualPrice: number;
          name?: string;
          description?: string;
        };
      }
    >(this.fns, 'updateGlobalPlansPricing');
    const result = await fn(payload);
    return result.data.pricing;
  }

  /** Asigna un PricingOverride (precio especial, % OFF, $ OFF) a una tienda */
  async setStorePricingOverride(payload: {
    storeId: string;
    type: 'custom_fixed_price' | 'percentage_discount' | 'fixed_discount';
    value: number;
    duration: 'lifetime' | 'recurring_cycles' | 'single_cycle';
    cyclesRemaining?: number;
    reason: string;
  }): Promise<{ success: boolean; storeId: string }> {
    const fn = httpsCallable<typeof payload, { success: boolean; storeId: string }>(
      this.fns,
      'setStorePricingOverride',
    );
    const result = await fn(payload);
    return result.data;
  }

  /** Revoca el PricingOverride de una tienda */
  async removeStorePricingOverride(
    storeId: string,
  ): Promise<{ success: boolean; storeId: string }> {
    const fn = httpsCallable<{ storeId: string }, { success: boolean; storeId: string }>(
      this.fns,
      'removeStorePricingOverride',
    );
    const result = await fn({ storeId });
    return result.data;
  }

  /** Prepaid Bridge: fija cobertura manual por transferencia con nota bancaria */
  async setStorePrepaidCoverage(payload: {
    storeId: string;
    currentPeriodEnd: string;
    notes?: string;
  }): Promise<{ success: boolean; storeId: string; currentPeriodEnd: string }> {
    const fn = httpsCallable<
      typeof payload,
      { success: boolean; storeId: string; currentPeriodEnd: string }
    >(this.fns, 'setStorePrepaidCoverage');
    const result = await fn(payload);
    return result.data;
  }

  async updateStore(
    id: string,
    data: Partial<Pick<Store, 'name' | 'ownerEmail' | 'logoUrl' | 'autoUpdate'>>,
  ): Promise<void> {
    await updateDoc(doc(this.db, 'stores', id), { ...data, updatedAt: serverTimestamp() });
  }

  async setStatus(id: string, status: 'active' | 'suspended'): Promise<void> {
    await updateDoc(doc(this.db, 'stores', id), { status, updatedAt: serverTimestamp() });
  }

  async resetStoreDeployStatus(id: string): Promise<void> {
    await updateDoc(doc(this.db, 'stores', id), {
      versionUpdateStatus: 'idle',
      versionUpdateProgress: null,
      versionUpdateTarget: null,
      redeployStatus: 'idle',
      redeployError: null,
      updatedAt: serverTimestamp(),
    });
  }

  /** Dormir tienda (suspender sin eliminar): pausa el sitio y la excluye de deploys. */
  async suspendStore(storeId: string): Promise<void> {
    const fn = httpsCallable<{ storeId: string }, { success: boolean }>(this.fns, 'suspendStore');
    await fn({ storeId });
  }

  /** Reactivar tienda dormida: restaura el sitio con su versión activa. */
  async activateStore(storeId: string): Promise<void> {
    const fn = httpsCallable<{ storeId: string }, { success: boolean }>(this.fns, 'activateStore');
    await fn({ storeId });
  }

  async retryProvisioning(storeId: string): Promise<void> {
    const fn = httpsCallable<{ storeId: string }, { success: boolean }>(
      this.fns,
      'retryProvisioningV2',
    );
    await fn({ storeId });
  }

  async updateStoreConfig(storeId: string, config: Partial<StoreConfig>): Promise<void> {
    const fn = httpsCallable<
      { storeId: string; config: Partial<StoreConfig> },
      { success: boolean }
    >(this.fns, 'updateStoreConfig');
    await fn({ storeId, config });
  }

  async getStoreStaff(
    storeId: string,
  ): Promise<{ staff: StaffMember[]; invitations: PendingInvitation[] }> {
    const fn = httpsCallable<
      { storeId: string },
      { success: boolean; staff: StaffMember[]; invitations: PendingInvitation[] }
    >(this.fns, 'getStoreStaff');
    const result = await fn({ storeId });
    return {
      staff: result.data.staff ?? [],
      invitations: result.data.invitations ?? [],
    };
  }

  async inviteStaff(
    storeId: string,
    email: string,
    role: string,
  ): Promise<{ inviteEmailSent: boolean }> {
    const fn = httpsCallable<
      { storeId: string; email: string; role: string },
      { success: boolean; inviteEmailSent?: boolean }
    >(this.fns, 'inviteStaff');
    const result = await fn({ storeId, email, role });
    return { inviteEmailSent: result.data.inviteEmailSent !== false };
  }

  async generatePasswordResetLink(
    storeId: string,
    email: string,
  ): Promise<{ success: boolean; actionLink: string }> {
    const fn = httpsCallable<
      { storeId: string; email: string },
      { success: boolean; actionLink: string }
    >(this.fns, 'generatePasswordResetLink');
    const result = await fn({ storeId, email });
    return result.data;
  }

  async verifyDomain(
    storeId: string,
    domain: string,
  ): Promise<{ status: 'live' | 'pending'; dnsRecords: DnsRecord[] }> {
    const fn = httpsCallable<
      { storeId: string; domain: string },
      { success: boolean; status: string; dnsRecords: RawDnsRecord[] }
    >(this.fns, 'verifyDomainDNSStatus');
    const result = await fn({ storeId, domain });
    const normalizedStatus = normalizeDomainStatus(result.data.status);
    return {
      status: normalizedStatus,
      dnsRecords: mapDnsRecords(result.data.dnsRecords),
    };
  }

  async getStoreConfig(storeId: string): Promise<StoreConfig | null> {
    const fn = httpsCallable<{ storeId: string }, { config: StoreConfig | null }>(
      this.fns,
      'getStoreConfig',
    );
    const result = await fn({ storeId });
    return result.data.config;
  }

  async seedStore(
    storeId: string,
    includeMockData = true,
    provisioningMode = 'FULL_DEMO',
    verticalId?: string,
  ): Promise<void> {
    const fn = httpsCallable<
      { storeId: string; includeMockData: boolean; provisioningMode?: string; verticalId?: string },
      { success: boolean }
    >(this.fns, 'seedStore');
    await fn({ storeId, includeMockData, provisioningMode, verticalId });
  }

  async listTemplateVersions(forceRefresh = false): Promise<TemplateVersion[]> {
    const fn = httpsCallable<{ forceRefresh?: boolean }, { versions: TemplateVersion[] }>(
      this.fns,
      'listTemplateVersions',
    );
    const result = await fn({ forceRefresh });
    return result.data.versions;
  }

  async updateStoreVersion(storeId: string, version: string): Promise<void> {
    const fn = httpsCallable<{ storeId: string; version: string }, { success: boolean }>(
      this.fns,
      'updateStoreVersion',
    );
    await fn({ storeId, version });
  }

  async createCustomVertical(
    payload: CreateCustomVerticalPayload,
  ): Promise<{ success: boolean; vertical: VerticalOption }> {
    const fn = httpsCallable<
      CreateCustomVerticalPayload,
      { success: boolean; vertical: VerticalOption }
    >(this.fns, 'createCustomVertical');
    const result = await fn(payload);
    return result.data;
  }

  async getPlatformBillingConfig(): Promise<PlatformBillingConfig> {
    const fn = httpsCallable<void, PlatformBillingConfig>(this.fns, 'getPlatformBillingConfig');
    const result = await fn();
    return result.data;
  }

  async updatePlatformBillingConfig(payload: {
    monthlyPrice?: number;
    annualPrice?: number;
    mpAccessToken?: string;
  }): Promise<{ success: boolean; message: string; pricing: PlatformBillingConfig['pricing'] }> {
    const fn = httpsCallable<
      typeof payload,
      { success: boolean; message: string; pricing: PlatformBillingConfig['pricing'] }
    >(this.fns, 'updatePlatformBillingConfig');
    const result = await fn(payload);
    return result.data;
  }

  async getStoreSubscription(storeId: string): Promise<StoreSubscriptionInfo> {
    const fn = httpsCallable<{ storeId: string }, StoreSubscriptionInfo>(
      this.fns,
      'getStoreSubscription',
    );
    const result = await fn({ storeId });
    return result.data;
  }

  async createStoreSubscriptionLink(
    storeId: string,
    billingCycle: 'monthly' | 'annual',
    payerEmail?: string,
  ): Promise<{
    success: boolean;
    checkoutUrl: string;
    billingCycle: string;
    amount: number;
  }> {
    const fn = httpsCallable<
      { storeId: string; billingCycle: 'monthly' | 'annual'; payerEmail?: string },
      { success: boolean; checkoutUrl: string; billingCycle: string; amount: number }
    >(this.fns, 'createStoreSubscriptionLink');
    const result = await fn({ storeId, billingCycle, payerEmail });
    return result.data;
  }

  async updateStoreSubscriptionStatus(payload: {
    storeId: string;
    status?: 'active' | 'complimentary' | 'trial' | 'past_due' | 'suspended';
    customMonthlyPrice?: number | null;
    customAnnualPrice?: number | null;
    discountPercent?: number | null;
    trialDays?: number | null;
    notes?: string;
    simulateExpiration?: 'imminent' | 'grace_period' | 'expired_suspended' | 'reset_trial';
  }): Promise<{ success: boolean; storeId: string; status?: string }> {
    const fn = httpsCallable<
      typeof payload,
      { success: boolean; storeId: string; status?: string }
    >(this.fns, 'updateStoreSubscriptionStatus');
    const result = await fn(payload);
    return result.data;
  }
}

export interface DomainStatusResponse {
  success: boolean;
  domain?: string;
  status?: 'PENDING_DNS' | 'VALIDATING' | 'ACTIVE';
  sslStatus?: string;
  dnsRecords?: { aRecords: string[]; txtRecord?: string };
}

export interface PurgeStoreDataResult {
  success: boolean;
  shardProjectId: string;
  deleted: Record<string, number>;
  errors: string[];
}

export interface StoreLogsResponse {
  success: boolean;
  project: string;
  entries: Array<{
    id?: string;
    timestamp: string;
    severity: string;
    function?: string;
    message: string;
    raw?: string;
    project?: string;
    source?: 'orders' | 'system' | 'cloud' | string;
  }>;
  truncated: boolean;
}

export interface HealShardsReport {
  success: boolean;
  shards: number;
  results: Array<{ shard: string; apis: string; iam: string; status: string }>;
}

export interface MpPingResponse {
  ok: boolean;
  account?: { id?: number | string | null; email?: string; nickname?: string };
  message?: string;
  status?: number;
}

export interface PlatformBillingConfig {
  pricing: {
    name: string;
    description: string;
    monthlyPrice: number;
    annualPrice: number;
  };
  isMasterAdmin: boolean;
  platformMercadoPago: {
    isConfigured: boolean;
    maskedToken: string | null;
  };
}

export interface StoreSubscriptionInfo {
  storeId: string;
  subscription: {
    status?: 'active' | 'complimentary' | 'trial' | 'past_due' | 'suspended';
    billingCycle?: 'monthly' | 'annual';
    amount?: number;
    currentPeriodEnd?:
      | { toDate?: () => Date; seconds?: number; _seconds?: number }
      | string
      | Date
      | null;
    trialDays?: number;
    trialStartDate?:
      | { toDate?: () => Date; seconds?: number; _seconds?: number }
      | string
      | Date
      | null;
    trialEndDate?:
      | { toDate?: () => Date; seconds?: number; _seconds?: number }
      | string
      | Date
      | null;
    customMonthlyPrice?: number;
    customAnnualPrice?: number;
    discountPercent?: number;
    notes?: string;
    lastGeneratedLink?: string;
  };
  pricingOverride?: PricingOverride | null;
  basePricing: {
    name: string;
    description: string;
    monthlyPrice: number;
    annualPrice: number;
  };
  isMasterAdmin: boolean;
  overdueDetails?: {
    isOverdue: boolean;
    overdueDays: number;
    surchargePercent: number;
    surchargeAmount: number;
    totalAmount: number;
  };
}
