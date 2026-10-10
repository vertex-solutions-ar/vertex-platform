import { Component, ChangeDetectionStrategy, computed, inject, input, signal } from '@angular/core';
import { errorMessage } from '@core/utils/error.util';
import { FormsModule } from '@angular/forms';
import { StoresService } from '@core/services/stores';
import type { Store } from '@core/models/store';
import { StoreDetailStaffService } from '../store-detail/services/store-detail-staff.service';
import { StoreDetailDomainsService } from '../store-detail/services/store-detail-domains.service';
import { StoreDetailOrchestrationService } from '../store-detail/services/store-detail-orchestration.service';

@Component({
  selector: 'app-store-detail-domains',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './store-detail-domains.html',
  styleUrls: ['../store-detail/store-detail.scss', './store-detail-domains.scss'],
})
export class StoreDetailDomains {
  readonly store = input<Store | null>(null);
  private storesService = inject(StoresService);
  private staffService = inject(StoreDetailStaffService);
  private domainsService = inject(StoreDetailDomainsService);
  private orchestrationService = inject(StoreDetailOrchestrationService);
  readonly oauthRedirect = this.orchestrationService.oauthRedirect;

  readonly subInput = signal('');
  readonly subChecking = signal(false);
  readonly subAvailable = signal(false);
  readonly subTaken = signal(false);
  readonly subReason = signal('');
  readonly subMessage = signal('');
  readonly subSuggestions = signal<string[]>([]);
  readonly subUpdating = signal(false);
  readonly subModalOpen = signal(false);
  readonly subResult = signal('');
  readonly subError = signal('');
  readonly subCopied = signal(false);
  private subTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SUB_DEBOUNCE_MS = 400;

  subTakenMessage(): string {
    switch (this.subReason()) {
      case 'RESERVED_KEYWORD':
        return 'Palabra reservada';
      case 'RESERVED_BY_FIREBASE':
        // El ID existe en Firebase (de otro proyecto) aunque su sitio esté vacío.
        return 'Nombre no disponible en Firebase';
      case 'ALREADY_REGISTERED':
        return 'Ya está en uso en Vertex';
      case 'CHECK_UNAVAILABLE':
        return 'No pudimos verificar';
      case 'TAKEN':
      default:
        return 'No disponible';
    }
  }

  /** Icono del estado de disponibilidad (bi-*). */
  subFeedbackIcon(): string {
    switch (this.subReason()) {
      case 'RESERVED_KEYWORD':
        return 'bi-lock';
      case 'RESERVED_BY_FIREBASE':
        return 'bi-shield-lock';
      case 'ALREADY_REGISTERED':
        return 'bi-shop';
      case 'CHECK_UNAVAILABLE':
        return 'bi-cloud-slash';
      default:
        return 'bi-x-circle';
    }
  }

  subCurrentUrl(): string {
    const s = this.store();
    return s?.defaultUrl || (s?.customDomain ? `https://${s.customDomain}` : '');
  }

  async checkSubdomain(raw: string): Promise<void> {
    const value = String(raw || '').trim();
    if (value.length < 4) {
      this.subChecking.set(false);
      this.subAvailable.set(false);
      this.subTaken.set(false);
      this.subReason.set('');
      this.subMessage.set('');
      this.subSuggestions.set([]);
      this.subResult.set('');
      return;
    }
    this.subChecking.set(true);
    this.subResult.set('');
    try {
      const res = await this.storesService.checkSubdomainAvailability(value, this.store()?.id);
      this.subAvailable.set(res.available);
      this.subTaken.set(!res.available);
      this.subReason.set(res.reason || '');
      this.subMessage.set(res.message || '');
      this.subSuggestions.set(res.suggestions || []);
      if (!res.available && res.sanitized && res.sanitized !== value) {
        this.subInput.set(res.sanitized);
      }
    } catch (err: unknown) {
      const errStr = String(
        (err && typeof err === 'object' && 'code' in err ? (err as { code: string }).code : '') ||
          errorMessage(err, ''),
      ).toLowerCase();
      if (
        errStr.includes('internal') ||
        errStr.includes('unavailable') ||
        errStr.includes('network') ||
        errStr.includes('permission-denied')
      ) {
        this.subError.set(
          'No se pudo verificar la disponibilidad en este momento. Reintentá en unos segundos.',
        );
      } else {
        this.subError.set(
          errorMessage(
            err,
            'No se pudo verificar la disponibilidad en este momento. Reintentá en unos segundos.',
          ),
        );
      }
      this.subAvailable.set(false);
      this.subTaken.set(false);
    } finally {
      this.subChecking.set(false);
    }
  }

  onSubInputChange(value: string): void {
    this.subInput.set(String(value || ''));
    if (this.subTimer) {
      clearTimeout(this.subTimer);
    }
    this.subTimer = setTimeout(() => {
      void this.checkSubdomain(this.subInput());
    }, this.SUB_DEBOUNCE_MS);
  }

  pickSuggestion(s: string): void {
    this.subInput.set(s);
    void this.checkSubdomain(s);
  }

  openSubModal(): void {
    this.subError.set('');
    this.subResult.set('');
    this.subModalOpen.set(true);
  }

  async confirmSubdomainChange(): Promise<void> {
    const s = this.store();
    if (!s || this.subUpdating()) {
      return;
    }
    this.subUpdating.set(true);
    this.subError.set('');
    this.subResult.set('');
    try {
      const res = await this.storesService.updateStoreSubdomain(s.id, this.subInput());
      this.subResult.set(`Dirección actualizada: https://${res.subdomain}.web.app`);
      this.subModalOpen.set(false);
      this.subAvailable.set(false);
      this.subTaken.set(false);
      this.subSuggestions.set([]);
    } catch (err) {
      this.subError.set(errorMessage(err, 'No se pudo cambiar la dirección.'));
    } finally {
      this.subUpdating.set(false);
    }
  }

  copySubdomainUrl(): void {
    const url = this.subCurrentUrl();
    if (!url) {
      return;
    }
    void this.staffService.copyToClipboard(url);
    this.subCopied.set(true);
    setTimeout(() => this.subCopied.set(false), 1800);
  }

  /** Sitios/dominios extra contratados (add-on pago). */
  readonly extraDomainsEntitlement = computed(() =>
    Number(this.store()?.extraDomainsEntitlement || 0),
  );

  readonly domainInput = this.domainsService.domainInput;
  readonly domainStatus = this.domainsService.domainStatus;
  readonly dnsRecords = this.domainsService.dnsRecords;
  readonly isVerifyingDNS = this.domainsService.isVerifyingDNS;
  readonly isConnectingDomain = this.domainsService.isConnectingDomain;
  readonly dnsVerificationError = this.domainsService.dnsVerificationError;
  readonly dnsVerificationSuccess = this.domainsService.dnsVerificationSuccess;

  readonly hasDomainOwnership = signal(false);
  readonly hasDnsAccess = signal(false);
  readonly wantsRootOrWwwReady = signal(false);
  readonly canConnectDomain = computed(
    () =>
      !!this.domainInput().trim() &&
      this.hasDomainOwnership() &&
      this.hasDnsAccess() &&
      this.wantsRootOrWwwReady(),
  );

  // ── Mercado Pago ──────────────────────────────────────────────────────────

  readonly domainBackendStatus = signal<'ACTIVE' | 'VALIDATING' | 'PENDING_DNS' | ''>('');
  readonly domainRefreshLoading = signal(false);
  readonly domainCheckError = signal('');
  readonly domainDisconnectOpen = signal(false);
  readonly isDisconnectingDomain = signal(false);
  readonly domainDisconnectError = signal('');
  readonly domainCopiedKey = signal<string | null>(null);
  /** Entorno de la consola Platform (para URLs canónicas de ecommerce). */
  isDevPlatformEnv(): boolean {
    return (
      typeof window !== 'undefined' &&
      (window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1' ||
        window.location.hostname.includes('-dev.web.app') ||
        window.location.hostname.endsWith('.local'))
    );
  }

  readonly domainIsLive = computed(
    () => this.domainStatus() === 'live' || this.domainBackendStatus() === 'ACTIVE',
  );

  // ── Mercado Pago: modo de operación según token resuelto (banners) ───────

  copyOAuthUri(): Promise<void> {
    const uri = this.oauthRedirect()?.redirectUri;
    return uri ? this.staffService.copyToClipboard(uri) : Promise.resolve();
  }

  verifyDNS(silent = false): Promise<unknown> {
    const s = this.store();
    return s
      ? this.domainsService.verifyDNS(s.id, s.customDomain || this.domainInput(), silent)
      : Promise.resolve();
  }

  connectDomain(): Promise<unknown> {
    const s = this.store();
    return s ? this.domainsService.connectDomain(s.id, this.domainInput()) : Promise.resolve();
  }

  async loadDomainStatus(): Promise<void> {
    const s = this.store();
    if (!s?.customDomain) {
      return;
    }
    this.domainRefreshLoading.set(true);
    this.domainCheckError.set('');
    try {
      const result = await this.storesService.getDomainStatus(s.id, s.customDomain);
      this.domainBackendStatus.set(
        (result.status as 'ACTIVE' | 'VALIDATING' | 'PENDING_DNS') || '',
      );
      if (result.status === 'ACTIVE') {
        await this.verifyDNS(true);
      }
    } catch (err) {
      this.domainCheckError.set(
        errorMessage(
          err,
          'No se pudo consultar el estado del dominio. Reintentá en unos segundos.',
        ),
      );
    } finally {
      this.domainRefreshLoading.set(false);
    }
  }

  copyDnsRecord(type: string, value: string): void {
    const key = `${type}:${value}`;
    this.domainCopiedKey.set(key);
    void this.staffService.copyToClipboard(value);
    window.setTimeout(() => {
      if (this.domainCopiedKey() === key) {
        this.domainCopiedKey.set(null);
      }
    }, 1800);
  }

  openDisconnectDomainModal(): void {
    this.domainDisconnectError.set('');
    this.domainDisconnectOpen.set(true);
  }

  cancelDisconnectDomainModal(): void {
    if (this.isDisconnectingDomain()) {
      return;
    }
    this.domainDisconnectOpen.set(false);
  }

  /** Desvincula el dominio (disconnectDomain callable) y espera el onSnapshot. */
  async confirmDisconnectDomain(): Promise<void> {
    const s = this.store();
    if (!s?.customDomain || this.isDisconnectingDomain()) {
      return;
    }
    this.isDisconnectingDomain.set(true);
    this.domainDisconnectError.set('');
    try {
      await this.storesService.disconnectDomain(s.id, s.customDomain);
      this.domainDisconnectOpen.set(false);
      this.domainBackendStatus.set('');
      this.domainInput.set('');
    } catch (err) {
      this.domainDisconnectError.set(
        errorMessage(err, 'No se pudo desvincular el dominio. Reintentá en unos segundos.'),
      );
    } finally {
      this.isDisconnectingDomain.set(false);
    }
  }

  /** Health check en vivo: prueba el Access Token contra api.mercadopago.com/users/me. */
}
