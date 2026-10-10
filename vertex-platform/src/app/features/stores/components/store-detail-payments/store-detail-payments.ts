import {
  Component,
  ChangeDetectionStrategy,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StoresService } from '@core/services/stores';
import { AuthService } from '@core/services/auth';
import { StoreDetailStaffService } from '../store-detail/services/store-detail-staff.service';
import { formatDateUtil, parseDateToMillis } from '../store-detail/services/store-detail.util';
import { StoreDetailPaymentsService } from '../../services/store-detail-payments.service';
import type { Store } from '@core/models/store';

@Component({
  selector: 'app-store-detail-payments',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe, DecimalPipe],
  templateUrl: './store-detail-payments.html',
  styleUrls: ['../store-detail/store-detail.scss', './store-detail-payments.scss'],
})
export class StoreDetailPayments {
  readonly store = input<Store | null>(null);
  private storeEffect = effect(() => this.payments.store.set(this.store()));
  readonly payments = inject(StoreDetailPaymentsService);
  readonly auth = inject(AuthService);
  private storesService = inject(StoresService);
  private staffService = inject(StoreDetailStaffService);
  readonly formatDate = formatDateUtil;

  readonly activeSubTab = this.payments.activeSubTab;
  setSubTab(tab: 'saas' | 'gateway'): void {
    this.payments.activeSubTab.set(tab);
  }

  readonly customAnnualPriceInput = this.payments.customAnnualPriceInput;
  readonly customMonthlyPriceInput = this.payments.customMonthlyPriceInput;
  readonly discountPercentInput = this.payments.discountPercentInput;
  readonly discountSaveSuccess = this.payments.discountSaveSuccess;
  readonly isGeneratingSubLink = this.payments.isGeneratingSubLink;
  readonly isGrantingTrial = this.payments.isGrantingTrial;
  readonly isLoadingPayment = this.payments.isLoadingPayment;
  readonly isLoadingSubscription = this.payments.isLoadingSubscription;
  readonly isSavingDiscount = this.payments.isSavingDiscount;
  readonly isSavingPayment = this.payments.isSavingPayment;
  readonly isSimulatingExpiration = this.payments.isSimulatingExpiration;
  readonly mpAccessToken = this.payments.mpAccessToken;
  readonly mpAccountEmail = this.payments.mpAccountEmail;
  readonly mpPingResult = this.payments.mpPingResult;
  readonly mpPinging = this.payments.mpPinging;
  readonly mpPublicKey = this.payments.mpPublicKey;
  readonly mpSandbox = this.payments.mpSandbox;
  readonly mpTokenMasked = this.payments.mpTokenMasked;
  readonly mpValidationStatus = this.payments.mpValidationStatus;
  readonly paymentSaveError = this.payments.paymentSaveError;
  readonly paymentSaveSuccess = this.payments.paymentSaveSuccess;
  readonly showMpToken = this.payments.showMpToken;
  readonly showSimulationTools = this.payments.showSimulationTools;
  readonly storeSubscription = this.payments.storeSubscription;
  readonly subLinkError = this.payments.subLinkError;
  readonly subLinkGenerated = this.payments.subLinkGenerated;
  readonly subscriptionStatusSelect = this.payments.subscriptionStatusSelect;
  readonly trialDaysInput = this.payments.trialDaysInput;
  savePaymentConfig(): Promise<void> {
    return this.payments.savePaymentConfig();
  }

  testMpConnection(): Promise<void> {
    return this.payments.testMpConnection();
  }

  generateSubscriptionLink(cycle: 'monthly' | 'annual'): Promise<void> {
    return this.payments.generateSubscriptionLink(cycle);
  }

  updateAccountStatus(
    newStatus?: 'active' | 'complimentary' | 'trial' | 'past_due' | 'suspended',
  ): Promise<void> {
    return this.payments.updateAccountStatus(newStatus);
  }

  saveCustomSubscriptionPricing(): Promise<void> {
    return this.payments.saveCustomSubscriptionPricing();
  }

  grantTrial(days: number): Promise<void> {
    return this.payments.grantTrial(days);
  }

  grantFreeStore(): Promise<void> {
    return this.payments.grantFreeStore();
  }

  simulateStoreExpiration(
    period:
      'reset_trial' | 'imminent' | 'grace' | 'grace_period' | 'expired_suspended' | 'canceled',
  ): Promise<void> {
    return this.payments.simulateStoreExpiration(period as never);
  }
  isDevPlatformEnv(): boolean {
    return (
      typeof window !== 'undefined' &&
      (window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1' ||
        window.location.hostname.includes('-dev.web.app') ||
        window.location.hostname.endsWith('.local'))
    );
  }

  readonly mpMode = computed<'sandbox' | 'test' | 'prod'>(() => {
    const raw = this.mpAccessToken().trim() || this.mpTokenMasked() || '';
    if (raw.startsWith('APP_USR-')) {
      return 'prod'; // protege: nunca tratar credenciales reales como sandbox
    }
    if (raw.startsWith('TEST-')) {
      return 'test';
    }
    // Sin token visible: la validación previa distingue producción real (APP) de pruebas.
    if (this.mpValidationStatus() === 'valid' && !this.mpSandbox()) {
      return 'prod';
    }
    if (this.mpValidationStatus() === 'valid') {
      return 'test';
    }
    return 'sandbox';
  });

  readonly mpModeLabel = computed(() => {
    switch (this.mpMode()) {
      case 'prod':
        return 'Producción Real (APP_USR-)';
      case 'test':
        return 'Pruebas (TEST-)';
      default:
        return 'Sandbox de Plataforma (sin credenciales propias)';
    }
  });

  // ── SaaS: precios efectivos y gating de cobro ─────────────────────────────
  readonly saasMonthly = computed(() => {
    const sub = this.storeSubscription()?.subscription;
    return Number(
      sub?.customMonthlyPrice ?? this.storeSubscription()?.basePricing?.monthlyPrice ?? 50000,
    );
  });
  readonly saasAnnual = computed(() => {
    const sub = this.storeSubscription()?.subscription;
    return Number(
      sub?.customAnnualPrice ?? this.storeSubscription()?.basePricing?.annualPrice ?? 500000,
    );
  });
  /** Meses que el plan anual "regala" respecto a pagar 12 meses sueltos. */
  readonly saasAnnualMonthsFree = computed(() => {
    if (!this.saasMonthly()) {
      return 0;
    }
    return Math.max(
      0,
      Math.round((this.saasMonthly() * 12 - this.saasAnnual()) / this.saasMonthly()),
    );
  });
  /** Indica si la tienda cuenta con cortesía o vigencia ilimitada permanente (sin fecha fin real). */
  readonly isUnlimitedPermanently = computed(() => {
    const sub = this.storeSubscription()?.subscription;
    const s = this.store();
    if (s?.isExempt || s?.plan === 'internal' || sub?.status === 'complimentary') {
      return true;
    }
    const end = sub?.currentPeriodEnd;
    if (end) {
      const ms = parseDateToMillis(end);
      if (ms && new Date(ms).getFullYear() > 2099) {
        return true;
      }
    }
    return false;
  });

  /** Estados en los que NO corresponde generar un cobro. */
  readonly saasChargeBlocked = computed(() => {
    const st = this.storeSubscription()?.subscription?.status;
    return (
      this.isUnlimitedPermanently() ||
      st === 'complimentary' ||
      st === 'suspended' ||
      st === 'trial'
    );
  });

  /** Presentación homogénea del estado de suscripción (grilla resumen). */
  readonly saasStatusInfo = computed<{
    label: string;
    icon: string;
    tone: 'success' | 'warning' | 'danger' | 'primary' | 'neutral';
  }>(() => {
    const map: Record<
      string,
      {
        label: string;
        icon: string;
        tone: 'success' | 'warning' | 'danger' | 'primary' | 'neutral';
      }
    > = {
      active: { label: 'Activa', icon: 'check-circle-fill', tone: 'success' },
      complimentary: { label: 'Cortesía / Bonificada', icon: 'gift-fill', tone: 'primary' },
      trial: { label: 'Período de prueba', icon: 'stars', tone: 'warning' },
      past_due: { label: 'Período de gracia', icon: 'clock-history', tone: 'warning' },
      suspended: { label: 'Suspendida por pago', icon: 'slash-circle-fill', tone: 'danger' },
    };
    const st = String(this.storeSubscription()?.subscription?.status || '');
    return map[st] ?? { label: 'En configuración', icon: 'question-circle', tone: 'neutral' };
  });

  readonly saasBillingCycleLabel = computed(() =>
    this.storeSubscription()?.subscription?.billingCycle === 'annual' ? 'Anual' : 'Mensual',
  );

  // ── SaaS Subscription Vertex ──────────────────────────────────────────────

  readonly trialRemainingDays = computed(() => {
    const sub = this.storeSubscription()?.subscription;
    if (sub?.status !== 'trial') {
      return 0;
    }
    const endTs = sub.trialEndDate || sub.currentPeriodEnd;
    if (!endTs) {
      return 0;
    }
    const endMs = parseDateToMillis(endTs);
    if (!endMs) {
      return 0;
    }
    const diffMs = endMs - Date.now();
    return Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
  });

  // QA Lab & Expiration Simulation

  readonly publicCheckoutUrl = computed(() => {
    const s = this.store();
    if (!s) {
      return '';
    }
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}/pay/${s.id}`;
  });

  readonly whatsAppShareUrl = computed(() => {
    const s = this.store();
    const url = this.publicCheckoutUrl();
    if (!s || !url) {
      return '';
    }
    const text = encodeURIComponent(
      `¡Hola! Te comparto el enlace seguro para abonar la suscripción de tu tienda ${s.name} en Vertex: ${url}`,
    );
    return `https://wa.me/?text=${text}`;
  });

  readonly copiedPublicLink = signal(false);

  copyPublicCheckoutUrl(): void {
    const url = this.publicCheckoutUrl();
    if (!url) {
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(url);
    }
    this.copiedPublicLink.set(true);
    setTimeout(() => this.copiedPublicLink.set(false), 2500);
  }

  copyWebhookUrl(storeId: string): Promise<void> {
    const isDev =
      typeof window !== 'undefined' &&
      (window.location.hostname === 'localhost' ||
        window.location.hostname.includes('-dev.web.app') ||
        window.location.hostname.endsWith('.local'));
    const url = `https://us-central1-${
      isDev ? 'ecommerce-vertex-dev' : 'ecommerce-vertex'
    }.cloudfunctions.net/mercadoPagoWebhookHandler?tenant=${storeId}`;
    return this.staffService.copyToClipboard(url);
  }

  // ── Super Admin: Pricing Override & Prepaid Bridge ────────────────────────
  readonly showPricingOverrideModal = this.payments.showPricingOverrideModal;
  readonly isSavingOverride = this.payments.isSavingOverride;
  readonly overrideType = this.payments.overrideType;
  readonly overrideValue = this.payments.overrideValue;
  readonly overrideDuration = this.payments.overrideDuration;
  readonly overrideCyclesRemaining = this.payments.overrideCyclesRemaining;
  readonly overrideReason = this.payments.overrideReason;

  readonly isSavingPrepaid = this.payments.isSavingPrepaid;
  readonly prepaidPeriodEndInput = this.payments.prepaidPeriodEndInput;
  readonly prepaidNotesInput = this.payments.prepaidNotesInput;

  readonly effectivePreviewMonthly = computed(() => {
    const base = this.storeSubscription()?.basePricing?.monthlyPrice || 50000;
    const type = this.overrideType();
    const val = Number(this.overrideValue()) || 0;
    if (type === 'custom_fixed_price') {
      return Math.max(0, val);
    }
    if (type === 'percentage_discount') {
      return Math.max(0, Math.round(base * (1 - val / 100)));
    }
    if (type === 'fixed_discount') {
      return Math.max(0, base - val);
    }
    return base;
  });

  readonly effectivePreviewAnnual = computed(() => {
    const base = this.storeSubscription()?.basePricing?.annualPrice || 500000;
    const type = this.overrideType();
    const val = Number(this.overrideValue()) || 0;
    if (type === 'custom_fixed_price') {
      return Math.max(0, val * 10);
    }
    if (type === 'percentage_discount') {
      return Math.max(0, Math.round(base * (1 - val / 100)));
    }
    if (type === 'fixed_discount') {
      return Math.max(0, base - val);
    }
    return base;
  });

  /**
   * Acordeón "Gestión y Facturación de la Tienda".
   *
   * Antes dependía de `data-bs-toggle="collapse"` (Bootstrap JS, no cargado) con
   * `aria-expanded="false"` fijo, así que la sección nunca se podía abrir.
   */
  readonly masterControlsOpen = signal(false);

  toggleMasterControls(): void {
    this.masterControlsOpen.update((open) => !open);
  }

  applyPricingOverride(): Promise<void> {
    return this.payments.applyPricingOverride();
  }

  revokePricingOverride(): Promise<void> {
    return this.payments.revokePricingOverride();
  }

  applyPrepaidCoverage(): Promise<void> {
    return this.payments.applyPrepaidCoverage();
  }
}
