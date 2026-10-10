import {
  ChangeDetectionStrategy,
  Component,
  inject,
  computed,
  signal,
  effect,
  DestroyRef,
  type OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import { errorMessage } from '@core/utils/error.util';
import { RouterLink, ActivatedRoute, Router } from '@angular/router';
import { DatePipe } from '@angular/common';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { StoresService } from '@core/services/stores';
import { AppSpinner } from '../../../../shared/components/app-spinner/app-spinner';
import { FormatLabelPipe } from '../../../../shared/pipes/format-label.pipe';

import { getFirestore, doc, onSnapshot, collection, getDocs, updateDoc } from 'firebase/firestore';
import { AuthService } from '@core/services/auth';
import { StoreDetailStaffService } from './services/store-detail-staff.service';
import { StoreDetailDomainsService } from './services/store-detail-domains.service';
import { StoreDetailOrchestrationService } from './services/store-detail-orchestration.service';
import type { PendingInvitation, Store } from '@core/models/store';
import {
  formatDateUtil,
  statusLabelUtil,
  stepIconUtil,
  formatDeployHistoryUtil,
  type DeploymentHistoryItem,
  STEP_ORDER,
  type ActionProgressState,
  IDLE_STATE,
  isVersionOutdated,
} from './services/store-detail.util';
import { StoreDetailDomains } from '../store-detail-domains/store-detail-domains';
import { StoreDetailPayments } from '../store-detail-payments/store-detail-payments';
import { StoreDetailPaymentsService } from '../../services/store-detail-payments.service';

@Component({
  selector: 'app-store-detail',
  standalone: true,
  imports: [
    StoreDetailDomains,
    StoreDetailPayments,
    RouterLink,
    DatePipe,
    FormsModule,
    ReactiveFormsModule,
    AppSpinner,
    FormatLabelPipe,
  ],
  templateUrl: './store-detail.html',
  styleUrl: './store-detail.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StoreDetail implements OnInit {
  private storesService = inject(StoresService);
  readonly paymentsService = inject(StoreDetailPaymentsService);
  readonly auth = inject(AuthService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);
  private staffService = inject(StoreDetailStaffService);
  private domainsService = inject(StoreDetailDomainsService);
  private orchestrationService = inject(StoreDetailOrchestrationService);

  private db = getFirestore();
  private storeUnsub: (() => void) | null = null;
  private deployHistorySub: Subscription | null = null;
  readonly localStore = signal<Store | null>(null);
  readonly isStoreLoading = signal(true);

  readonly storeId = signal<string | null>(null);
  readonly deployHistory = signal<DeploymentHistoryItem[]>([]);
  readonly isLoadingHistory = signal(true);
  readonly oauthRedirect = this.orchestrationService.oauthRedirect;
  readonly activeTab = signal<
    'orquestacion' | 'equipo' | 'dominios' | 'historial' | 'pagos' | 'monitor'
  >('orquestacion');

  readonly store = computed(() => {
    const local = this.localStore();
    if (local) {
      return local;
    }
    const id = this.storeId();
    if (!id) {
      return null;
    }
    return this.storesService.stores().find((s) => s.id === id) ?? null;
  });

  readonly storeUrl = computed(() => {
    const s = this.store();
    if (!s) {
      return '';
    }
    return typeof window !== 'undefined' && window.location.hostname === 'localhost'
      ? `http://localhost:4201/shop?tenantId=${s.slug}`
      : s.defaultUrl;
  });

  readonly orderedSteps = computed(() =>
    STEP_ORDER.filter((id) => id in (this.store()?.provisioningSteps ?? {})),
  );

  readonly provisioningSnapshot = computed(() =>
    this.orchestrationService.computeProvisioningSnapshot(this.store()),
  );

  readonly progressPercent = computed(() => this.provisioningSnapshot().percent);
  readonly isSeeding = this.orchestrationService.isSeeding;
  readonly isRetrying = this.orchestrationService.isRetrying;
  readonly isDeleting = this.orchestrationService.isDeleting;
  readonly isSuspending = this.orchestrationService.isSuspending;
  readonly isActivating = this.orchestrationService.isActivating;
  readonly isSaving = this.orchestrationService.isSaving;
  readonly actionError = this.orchestrationService.actionError;
  readonly actionSuccess = this.orchestrationService.actionSuccess;
  readonly saveError = this.orchestrationService.saveError;

  readonly showDeleteConfirm = signal(false);
  readonly showSleepConfirm = signal(false);
  readonly showEditModal = signal(false);
  readonly logoPreviewError = signal(false);

  readonly localDeployError = computed<string>(() => {
    const s = this.store();
    return s ? this.orchestrationService.getLocalDeployError(s.id) : '';
  });

  readonly isDeploying = computed<boolean>(() => {
    const s = this.store();
    return s ? this.orchestrationService.isStoreDeploying(s.id) : false;
  });

  readonly deployActionState = computed<ActionProgressState>(() =>
    this.orchestrationService.computeDeployActionState(this.store()),
  );

  readonly suspendActionState = signal<ActionProgressState>(IDLE_STATE);
  readonly domainActionState = signal<ActionProgressState>(IDLE_STATE);
  readonly retryActionState = signal<ActionProgressState>(IDLE_STATE);

  readonly isStoreUpdating = computed<boolean>(() => {
    const s = this.store();
    return s ? this.orchestrationService.isStoreUpdating(s.id) : false;
  });

  readonly isDiagnosticsUpdating = signal(false);

  readonly showDiagnostics = signal(false);

  // ── Subdominio gratuito .web.app ───────────────────────────────────────────
  readonly domainStatus = this.domainsService.domainStatus;
  readonly domainInput = this.domainsService.domainInput;

  deleteConfirmInput = '';
  sleepConfirmInput = '';
  readonly editForm = this.orchestrationService.editForm;

  readonly staff = this.staffService.staff;
  readonly invitations = this.staffService.invitations;
  readonly isLoadingStaff = this.staffService.isLoadingStaff;
  readonly isInvitingStaff = this.staffService.isInvitingStaff;
  readonly inviteError = this.staffService.inviteError;
  readonly inviteSuccess = this.staffService.inviteSuccess;
  readonly resendingInviteId = signal<string | null>(null);
  readonly generatedResetLink = this.staffService.generatedResetLink;
  readonly isGeneratingLink = this.staffService.isGeneratingLink;
  readonly copyFeedbackSuccess = this.staffService.copyFeedbackSuccess;
  readonly inviteForm = this.staffService.inviteForm;

  readonly availableVersions = this.orchestrationService.versions;
  readonly isLoadingVersions = this.orchestrationService.isLoadingVersions;
  readonly latestVersion = this.orchestrationService.latestVersion;
  readonly isUpdatingAutoUpdate = signal(false);
  readonly selectedVersion = signal('0.5.0');
  readonly deployTargetType = signal<'version' | 'branch'>('version');
  readonly customBranchRef = signal('develop');
  readonly statusLabel = statusLabelUtil;

  /** Indica si hay una versión más reciente de la plantilla disponible para esta tienda. */
  readonly isUpdateAvailable = computed<boolean>(() => {
    const current = this.store()?.templateVersion;
    const latest = this.latestVersion()?.version;
    return isVersionOutdated(current, latest);
  });

  /** Clase de tono correcta para el badge del estado (no usar el raw status como clase). */
  readonly storeStatusBadge = computed<string>(() => {
    const tones: Record<string, string> = {
      active: 'badge--success',
      suspended: 'badge--danger',
      error: 'badge--danger',
      provisioning: 'badge--warning',
    };
    return tones[this.store()?.status || ''] ?? 'badge--neutral';
  });
  readonly stepIcon = stepIconUtil;
  readonly formatDate = formatDateUtil;

  constructor() {
    effect(() => {
      const s = this.store();
      if (s) {
        void this.orchestrationService.checkOauthRedirect(s);
        const latest = this.orchestrationService.latestVersion();
        if (!this.selectedVersion() || this.selectedVersion() === '0.5.0') {
          this.selectedVersion.set(s.templateVersion || latest?.version || '0.5.0');
        }
      }
    });

    this.destroyRef.onDestroy(() => {
      if (this.storeUnsub) {
        this.storeUnsub();
        this.storeUnsub = null;
      }
      if (this.deployHistorySub) {
        this.deployHistorySub.unsubscribe();
        this.deployHistorySub = null;
      }
    });
  }

  ngOnInit(): void {
    void this.loadVersions();
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const id = params.get('id');
      this.storeId.set(id);
      if (this.storeUnsub) {
        this.storeUnsub();
        this.storeUnsub = null;
      }
      if (this.deployHistorySub) {
        this.deployHistorySub.unsubscribe();
        this.deployHistorySub = null;
      }
      if (id) {
        try {
          this.storeUnsub = onSnapshot(
            doc(this.db, 'stores', id),
            (snap) => {
              if (snap.exists()) {
                this.localStore.set({ id: snap.id, ...snap.data() } as Store);
              }
            },
            () => {
              /* ignore error */
            },
          );
        } catch {
          /* ignore error */
        }
        this.refreshDeployHistory(id);
        void this.staffService.loadStaff(id);
      }
    });
  }

  copyOAuthUri(): Promise<void> {
    const uri = this.oauthRedirect()?.redirectUri;
    return uri ? this.staffService.copyToClipboard(uri) : Promise.resolve();
  }

  async loadVersions(force = false): Promise<void> {
    await this.orchestrationService.loadVersions(force);
    const latest = this.orchestrationService.latestVersion();
    const defaultVer =
      this.store()?.templateVersion ||
      latest?.version ||
      this.availableVersions()[0]?.version ||
      '0.9.4';
    this.selectedVersion.set(defaultVer);
  }

  async refreshVersions(): Promise<void> {
    await this.loadVersions(true);
  }

  async triggerDeployment(): Promise<void> {
    const s = this.store();
    const version = this.selectedVersion();
    if (!s) {
      return;
    }
    const storeId = s.id;
    this.orchestrationService.setDeployDismissed(storeId, false);
    this.orchestrationService.setUserInitiated(storeId, true, Date.now());
    this.orchestrationService.setStoreDeploying(storeId, true);
    this.orchestrationService.setStoreUpdating(storeId, true);
    this.orchestrationService.setLocalDeployError(storeId, '');
    try {
      if (this.deployTargetType() === 'branch') {
        const branchRef = this.customBranchRef().trim() || 'develop';
        await this.storesService.redeployStore(storeId, branchRef);
      } else if (version === s.templateVersion) {
        await this.storesService.redeployStore(storeId);
      } else {
        await this.storesService.updateStoreVersion(storeId, version);
      }
    } catch (err) {
      this.orchestrationService.setLocalDeployError(
        storeId,
        errorMessage(err, 'No se pudo iniciar el despliegue.'),
      );
    } finally {
      this.orchestrationService.setStoreDeploying(storeId, false);
      this.orchestrationService.setStoreUpdating(storeId, false);
    }
  }

  async upgradeToLatestVersion(): Promise<void> {
    const latest = this.latestVersion();
    if (!latest?.version) {
      return;
    }
    this.selectedVersion.set(latest.version);
    await this.triggerDeployment();
  }

  async toggleAutoUpdate(event: Event): Promise<void> {
    const s = this.store();
    if (!s) {
      return;
    }
    this.isUpdatingAutoUpdate.set(true);
    try {
      await this.storesService.updateStore(s.id, {
        autoUpdate: (event.target as HTMLInputElement).checked,
      });
    } catch (err) {
      console.error('Error updating autoUpdate:', err);
    } finally {
      this.isUpdatingAutoUpdate.set(false);
    }
  }

  setTab(tab: 'orquestacion' | 'equipo' | 'dominios' | 'historial' | 'pagos' | 'monitor'): void {
    this.activeTab.set(tab);
    if (typeof window !== 'undefined') {
      const container = document.querySelector('.tabs-container');
      if (container) {
        container.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }
    if (tab === 'monitor') {
      void this.loadStoreAlerts();
      if (this.logsEntries().length === 0) {
        void this.loadStoreLogs();
      }
    }
    const s = this.store();
    if (tab === 'dominios' && s?.customDomain) {
      if (!this.domainInput()) {
        this.domainInput.set(s.customDomain);
      }
      // Anti-hang: mostrar los registros estándar de Firebase Hosting de inmediato
      // (A → 199.36.158.100 + CNAME www → {site}.web.app) para que el spinner de
      // "Recuperando registros..." nunca quede en bucle.
      if (this.domainsService.dnsRecords().length === 0) {
        this.domainsService.dnsRecords.set([
          { host: '@', type: 'A', value: '199.36.158.100', requiredAction: 'ADD' },
          {
            host: 'www',
            type: 'CNAME',
            value: `${s.runtimeSiteId || s.id}.web.app`,
            requiredAction: 'ADD',
          },
        ]);
      }
      // Refresco de estado en background (silencioso, no pisa los records mostrados).
      void this.domainsService.verifyDNS(s.id, s.customDomain, true);
    }
    if (tab === 'equipo' && s) {
      void this.staffService.loadStaff(s.id, true);
    }
    if (tab === 'pagos' && s) {
      void this.paymentsService.loadPaymentConfig(s.id);
      void this.paymentsService.loadStoreSubscription(s.id);
    }
  }

  async loadStaff(force = true): Promise<void> {
    const s = this.store();
    if (s) {
      await this.staffService.loadStaff(s.id, force);
    }
  }

  sendInvitation(): Promise<void> {
    const s = this.store();
    return s ? this.staffService.sendInvitationFromForm(s.id).then(() => {}) : Promise.resolve();
  }

  isStaffMemberEmail(email: string): boolean {
    const e = String(email || '')
      .trim()
      .toLowerCase();
    if (!e) {
      return false;
    }
    return this.staff().some(
      (m) =>
        String(m.email || '')
          .trim()
          .toLowerCase() === e,
    );
  }

  async resendInvite(invite: PendingInvitation): Promise<void> {
    const s = this.store();
    if (!s || !invite?.email) {
      return;
    }
    this.resendingInviteId.set(invite.id);
    try {
      const ok = await this.staffService.sendInvitation(s.id, invite.email, invite.role);
      if (ok) {
        this.staffService.inviteSuccess.set(
          `Invitación reenviada a ${invite.email} — la fila se actualizó con la nueva fecha.`,
        );
      }
    } finally {
      this.resendingInviteId.set(null);
    }
  }

  generateAccessLink(email: string): Promise<void> {
    const s = this.store();
    return s ? this.staffService.generateAccessLink(s.id, email) : Promise.resolve();
  }

  formatVersion(v?: string): string {
    if (!v) {
      return 'v0.5.0';
    }
    return v.startsWith('v') ? v : `v${v}`;
  }

  copyToClipboard(text: string): Promise<void> {
    return this.staffService.copyToClipboard(text);
  }

  readonly logsSeverity = signal<'ALL' | 'WARNING' | 'ERROR'>('ALL');
  readonly logsQuery = signal('');
  readonly logsSinceMinutes = signal(2880);
  readonly activeWindow = signal<'60' | '360' | '1440' | '2880' | '10080' | 'all' | 'custom'>(
    '2880',
  );
  readonly customStartDate = signal('');
  readonly customEndDate = signal('');
  readonly logsSource = signal<'all' | 'orders' | 'system' | 'cloud'>('all');
  readonly logsLoading = signal(false);
  readonly logsError = signal('');
  readonly logsEntries = signal<
    Array<{
      id?: string;
      timestamp: string;
      severity: string;
      function?: string;
      message: string;
      raw?: string;
      project?: string;
      source?: 'orders' | 'system' | 'cloud' | string;
    }>
  >([]);
  readonly logsProject = signal('');
  readonly logsLoadedAt = signal<Date | null>(null);
  readonly expandedLogIds = signal<Set<string>>(new Set());
  readonly storeAlerts = signal<
    Array<{ key: string; severity: string; title: string; message: string }>
  >([]);
  readonly storeAlertsLoading = signal(false);
  readonly resolvingAlertKey = signal<string | null>(null);

  async loadStoreAlerts(): Promise<void> {
    const s = this.store();
    if (!s) {
      return;
    }
    this.storeAlertsLoading.set(true);
    try {
      const snap = await getDocs(collection(getFirestore(), 'alerts'));
      const mine: Array<{ key: string; severity: string; title: string; message: string }> = [];
      snap.forEach((d) => {
        const data = d.data() as {
          status?: string;
          severity?: string;
          storeId?: string;
          title?: string;
          message?: string;
        };
        if (data.status !== 'open') {
          return;
        }
        if (data.storeId && data.storeId !== s.id && data.storeId !== s.slug) {
          return;
        }
        mine.push({
          key: d.id,
          severity: data.severity || 'warning',
          title: data.title || d.id,
          message: data.message || '',
        });
      });
      this.storeAlerts.set(mine);
    } catch {
      /* sin alertas disponibles no debe romper la pestaña */
      this.storeAlerts.set([]);
    } finally {
      this.storeAlertsLoading.set(false);
    }
  }

  async resolveStoreAlert(key: string): Promise<void> {
    this.resolvingAlertKey.set(key);
    try {
      await updateDoc(doc(getFirestore(), 'alerts', key), {
        status: 'resolved',
        resolvedAt: new Date(),
      });
      this.storeAlerts.update((list) => list.filter((a) => a.key !== key));
    } finally {
      this.resolvingAlertKey.set(null);
    }
  }

  async loadStoreLogs(): Promise<void> {
    const s = this.store();
    if (!s) {
      return;
    }
    this.logsLoading.set(true);
    this.logsError.set('');
    try {
      const win = this.activeWindow();
      let sinceMinutes: number | undefined;
      let startDate: string | undefined;
      let endDate: string | undefined;

      if (win === 'custom') {
        startDate = this.customStartDate() || undefined;
        endDate = this.customEndDate() || undefined;
      } else if (win === 'all') {
        sinceMinutes = undefined;
      } else {
        sinceMinutes = parseInt(win, 10) || 2880;
      }

      const src = this.logsSource();
      const res = await this.storesService.getStoreLogs(s.id, {
        severity: this.logsSeverity() === 'ALL' ? undefined : this.logsSeverity(),
        query: this.logsQuery().trim() || undefined,
        sinceMinutes,
        startDate,
        endDate,
        source: src === 'all' ? undefined : src,
        limit: 100,
      });
      this.logsEntries.set(res.entries || []);
      this.logsProject.set(res.project || '');
      this.logsLoadedAt.set(new Date());
    } catch (err) {
      this.logsError.set(errorMessage(err, 'No se pudieron cargar los logs de la tienda.'));
      this.logsEntries.set([]);
    } finally {
      this.logsLoading.set(false);
    }
  }

  setLogsWindow(windowVal: '60' | '360' | '1440' | '2880' | '10080' | 'all' | 'custom'): void {
    this.activeWindow.set(windowVal);
    if (windowVal !== 'custom') {
      void this.loadStoreLogs();
    }
  }

  applyCustomDateFilter(): void {
    if (this.activeWindow() === 'custom') {
      void this.loadStoreLogs();
    }
  }

  setLogsSince(minutes: number): void {
    this.logsSinceMinutes.set(minutes);
    const win = String(minutes);
    if (win === '60' || win === '360' || win === '1440' || win === '2880' || win === '10080') {
      this.activeWindow.set(win);
    }
    void this.loadStoreLogs();
  }

  applyLogsFilters(): void {
    void this.loadStoreLogs();
  }

  cloudLogsUrl(): string {
    const project = this.logsProject() || 'ecommerce-vertex';
    return `https://console.cloud.google.com/logs/query;query=textPayload%3A%22${encodeURIComponent(
      this.store()?.slug || this.store()?.id || '',
    )}%22?project=${project}`;
  }

  copyLogMessage(message: string): void {
    void this.staffService.copyToClipboard(message);
  }

  copyLogPayload(payload: string): void {
    void this.staffService.copyToClipboard(payload);
  }

  toggleLogExpansion(id: string): void {
    if (!id) {
      return;
    }
    this.expandedLogIds.update((set) => {
      const next = new Set(set);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  isLogExpanded(id?: string): boolean {
    if (!id) {
      return false;
    }
    return this.expandedLogIds().has(id);
  }

  expandAllLogs(): void {
    const allIds = new Set<string>();
    for (const entry of this.logsEntries()) {
      const id = entry.id || entry.timestamp;
      if (id) {
        allIds.add(id);
      }
    }
    this.expandedLogIds.set(allIds);
  }

  collapseAllLogs(): void {
    this.expandedLogIds.set(new Set());
  }

  getLogSummary(message?: string): string {
    if (!message) {
      return '';
    }
    const firstLine = message.split(/\r?\n/)[0]?.trim() || '';
    if (firstLine.length > 120) {
      return firstLine.slice(0, 120) + '…';
    }
    return firstLine;
  }

  isLogExpandable(message?: string): boolean {
    if (!message) {
      return false;
    }
    return message.includes('\n') || message.length > 120;
  }

  logsSeverityClass(sev: string): string {
    const s = (sev || '').toUpperCase();
    if (s === 'ERROR' || s === 'CRITICAL' || s === 'ALERT' || s === 'EMERGENCY') {
      return 'log-sev log-sev--error';
    }
    if (s === 'WARNING' || s === 'NOTICE') {
      return 'log-sev log-sev--warn';
    }
    if (s === 'INFO' || s === 'DEBUG') {
      return 'log-sev log-sev--info';
    }
    return 'log-sev';
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

  /** Actualiza el estado del dominio consultando el callable getDomainStatus. */
  openEdit(): void {
    this.orchestrationService.openEditForm(this.store());
    this.showEditModal.set(true);
  }

  async saveStore(): Promise<void> {
    const id = this.store()?.id;
    if (id && (await this.orchestrationService.saveStoreFromForm(id))) {
      this.showEditModal.set(false);
    }
  }

  async suspend(): Promise<void> {
    const id = this.store()?.id;
    if (id && (await this.orchestrationService.suspendStore(id))) {
      this.showSleepConfirm.set(false);
    }
    this.sleepConfirmInput = '';
  }

  activate(): Promise<void> {
    const id = this.store()?.id;
    return id ? this.orchestrationService.activateStore(id).then(() => {}) : Promise.resolve();
  }

  dismissDeployProgress(): void {
    const s = this.store();
    if (s?.id) {
      this.orchestrationService.setDeployDismissed(s.id, true);
      if (s.versionUpdateStatus === 'updating' || s.redeployStatus === 'deploying') {
        void this.storesService.resetStoreDeployStatus(s.id);
      }
    }
  }

  retry(): Promise<void> {
    const id = this.store()?.id;
    return id ? this.orchestrationService.retryStep(id).then(() => {}) : Promise.resolve();
  }

  async deleteStore(): Promise<void> {
    const s = this.store();
    if (!s || this.deleteConfirmInput !== s.slug) {
      return;
    }
    if (await this.orchestrationService.deleteStore(s.id)) {
      void this.router.navigate(['/stores']);
    } else {
      this.showDeleteConfirm.set(false);
      this.deleteConfirmInput = '';
    }
  }

  private formatDeployHistory(history: DeploymentHistoryItem[]): DeploymentHistoryItem[] {
    const storeVer = this.store()?.templateVersion || this.store()?.appVersion;
    return formatDeployHistoryUtil(history, storeVer);
  }

  refreshDeployHistory(explicitId?: string): void {
    const id = explicitId || this.storeId() || this.route.snapshot.paramMap.get('id');
    if (this.deployHistorySub) {
      this.deployHistorySub.unsubscribe();
      this.deployHistorySub = null;
    }
    if (!id) {
      this.isLoadingHistory.set(false);
      return;
    }
    this.deployHistory.set([]);
    this.isLoadingHistory.set(true);
    this.deployHistorySub = this.storesService
      .getStoreDeploymentHistory(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((h) => {
        this.deployHistory.set(this.formatDeployHistory(h));
        this.isLoadingHistory.set(false);
      });
  }
}
