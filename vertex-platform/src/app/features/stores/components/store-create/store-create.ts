import { Component, DestroyRef, inject, signal, computed } from '@angular/core';
import type { OnInit } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { debounceTime, distinctUntilChanged } from 'rxjs';
import { StoresService, type RuntimeCapacitySummary } from '@core/services/stores';
import { DEFAULT_STORE_VERTICAL } from '@core/constants/store-defaults.constants';
import type { VerticalOption } from '@core/constants/business-verticals.constants';

import { RubroSelector } from '@shared/components/rubro-selector/rubro-selector';
import { CustomVerticalModal } from '../custom-vertical-modal/custom-vertical-modal';

// Must match backend: 3-30 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphens
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

export type { VerticalOption };

export interface ProvisioningModeOption {
  id: string;
  icon: string;
  name: string;
  description: string;
}

@Component({
  selector: 'app-store-create',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, DatePipe, RubroSelector, CustomVerticalModal],
  templateUrl: './store-create.html',
  styleUrl: './store-create.scss',
})
export class StoreCreate implements OnInit {
  private fb = inject(FormBuilder);
  private storesService = inject(StoresService);
  private router = inject(Router);

  readonly isSubmitting = signal(false);
  readonly errorMessage = signal('');
  readonly runtimeSummary = signal<RuntimeCapacitySummary | null>(null);
  readonly runtimeSummaryError = signal('');
  readonly showCustomVerticalModal = signal<boolean>(false);

  readonly logoPreview = signal<string | null>(null);
  readonly logoFileName = signal<string>('');
  readonly logoFileSize = signal<string>('');
  readonly isDraggingLogo = signal<boolean>(false);

  readonly verticals = this.storesService.allVerticals;

  readonly provisioningModes: ProvisioningModeOption[] = [
    {
      id: 'FULL_DEMO',
      icon: '🚀',
      name: 'Demo Completo',
      description: 'Catálogo de muestra + clientes y pedidos simulados.',
    },
    {
      id: 'CATALOG_ONLY',
      icon: '📦',
      name: 'Solo Catálogo',
      description: 'Categorías y productos iniciales listos para vender.',
    },
    {
      id: 'EMPTY',
      icon: '✨',
      name: 'Tienda Limpia',
      description: 'Estructura vacía lista para cargar productos desde cero.',
    },
  ];

  private destroyRef = inject(DestroyRef);
  readonly isCheckingSubdomain = signal(false);
  readonly subdomainAvailable = signal<boolean | null>(null);
  readonly subdomainError = signal('');
  readonly subdomainMessage = signal('');

  readonly form = this.fb.group({
    name: ['', Validators.required],
    slug: ['', [Validators.required, Validators.pattern(SLUG_RE)]],
    subdomain: ['', [Validators.required, Validators.pattern(/^[a-z0-9][a-z0-9-]{2,61}[a-z0-9]$/)]],
    ownerEmail: ['', [Validators.required, Validators.email]],
    logoUrl: [''],
    businessVertical: [DEFAULT_STORE_VERTICAL, Validators.required],
    provisioningMode: ['FULL_DEMO', Validators.required],
    verticalId: [DEFAULT_STORE_VERTICAL],
    includeMockData: [true],
    dedicatedProject: [false],
    initialSubscriptionStatus: ['trial', Validators.required],
    trialDays: [14, [Validators.min(1), Validators.max(365)]],
  });

  readonly trialDaysSignal = toSignal(this.form.get('trialDays')!.valueChanges, {
    initialValue: 14,
  });

  readonly projectedTrialEndDate = computed(() => {
    const raw = this.trialDaysSignal();
    const days = +(raw || 14);
    const d = new Date();
    d.setDate(d.getDate() + (isNaN(days) || days < 1 ? 14 : days));
    return d;
  });

  setInitialSubscription(status: 'trial' | 'complimentary' | 'active', days?: number): void {
    this.form.get('initialSubscriptionStatus')?.setValue(status);
    if (days !== undefined) {
      this.form.get('trialDays')?.setValue(days);
    }
  }

  onCustomTrialDaysChange(event: Event): void {
    const inputEl = event.target as HTMLInputElement;
    const rawVal = inputEl.value;
    let numVal = parseInt(rawVal, 10);
    if (isNaN(numVal) || numVal < 1) {
      numVal = 1;
      inputEl.value = '1';
    } else if (numVal > 365) {
      numVal = 365;
      inputEl.value = '365';
    }
    this.form.get('trialDays')?.setValue(numVal);
  }

  ngOnInit(): void {
    void (async () => {
      try {
        this.runtimeSummary.set(await this.storesService.getRuntimeCapacitySummary());
      } catch {
        this.runtimeSummaryError.set('No se pudo cargar la capacidad actual de shared-shards.');
      }
    })();

    this.form
      .get('name')
      ?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        const slugControl = this.form.get('slug');
        if (slugControl && !slugControl.dirty) {
          this.autoSlug();
        }
        const subControl = this.form.get('subdomain');
        if (subControl && !subControl.dirty) {
          this.autoSubdomain();
        }
      });

    this.form
      .get('subdomain')
      ?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((val) => {
        const clean = String(val || '').trim().toLowerCase();
        if (!clean || clean.length < 3) {
          this.subdomainAvailable.set(null);
          this.subdomainMessage.set('');
          this.subdomainError.set('');
        }
      });

    this.form
      .get('subdomain')
      ?.valueChanges.pipe(
        debounceTime(400),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((val) => {
        void this.verifySubdomain(val || '');
      });
  }

  selectVertical(id: string): void {
    this.form.get('businessVertical')?.setValue(id);
    this.form.get('verticalId')?.setValue(id);
  }

  onCustomVerticalCreated(vertical: VerticalOption): void {
    if (vertical?.id) {
      this.selectVertical(vertical.id);
    }
    this.showCustomVerticalModal.set(false);
  }

  selectMode(id: string): void {
    this.form.get('provisioningMode')?.setValue(id);
    this.form.get('includeMockData')?.setValue(id === 'FULL_DEMO');
  }

  autoSlug(): void {
    const name = this.form.get('name')?.value ?? '';
    const clean = name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 26);
    this.form.get('slug')?.setValue(clean);
    this.form.get('slug')?.updateValueAndValidity();
    const suggested = clean ? `vtx-${clean}` : '';
    this.form.get('subdomain')?.setValue(suggested);
    this.form.get('subdomain')?.updateValueAndValidity();
  }

  autoSubdomain(): void {
    this.autoSlug();
  }

  async verifySubdomain(sub: string): Promise<void> {
    const clean = sub.trim().toLowerCase();
    if (!clean || clean.length < 3) {
      this.subdomainAvailable.set(null);
      this.subdomainError.set('');
      this.subdomainMessage.set('');
      return;
    }
    this.isCheckingSubdomain.set(true);
    this.subdomainError.set('');
    try {
      const res = await this.storesService.checkSubdomainAvailability(clean);
      const currentVal = String(this.form.get("subdomain")?.value || "").trim().toLowerCase();
      if (currentVal !== clean) {
        return;
      }
      this.subdomainAvailable.set(res.available);
      if (res.available) {
        this.subdomainMessage.set(`✓ https://${res.sanitized}.web.app disponible`);
        this.subdomainError.set('');
      } else {
        this.subdomainMessage.set('');
        this.subdomainError.set(
          res.reason === 'reserved'
            ? '✕ Palabra reservada por la plataforma'
            : res.reason === 'taken'
              ? '✕ En uso por otra tienda'
              : res.message || '✕ Subdominio no disponible',
        );
      }
    } catch {
      this.subdomainAvailable.set(false);
      this.subdomainError.set('✕ Error al verificar subdominio');
    } finally {
      this.isCheckingSubdomain.set(false);
    }
  }

  onLogoFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      this.processLogoFile(input.files[0]);
    }
  }

  onLogoDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingLogo.set(true);
  }

  onLogoDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingLogo.set(false);
  }

  onLogoDropped(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingLogo.set(false);
    if (event.dataTransfer?.files && event.dataTransfer.files[0]) {
      this.processLogoFile(event.dataTransfer.files[0]);
    }
  }

  private processLogoFile(file: File): void {
    if (!file.type.startsWith('image/')) {
      this.errorMessage.set(
        'Por favor seleccioná un archivo de imagen válido (PNG, JPG, SVG o WebP).',
      );
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      this.errorMessage.set('El logo no debe superar los 2MB de tamaño.');
      return;
    }

    this.logoFileName.set(file.name);
    this.logoFileSize.set(`${(file.size / 1024).toFixed(1)} KB`);

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      this.logoPreview.set(dataUrl);
      this.form.get('logoUrl')?.setValue(dataUrl);
    };
    reader.readAsDataURL(file);
  }

  removeLogo(): void {
    this.logoPreview.set(null);
    this.logoFileName.set('');
    this.logoFileSize.set('');
    this.form.get('logoUrl')?.setValue('');
  }

  async onSubmit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.isSubmitting.set(true);
    this.errorMessage.set('');
    try {
      const val = this.form.value;
      const rawSub = String(val.subdomain || '')
        .trim()
        .toLowerCase();
      const explicitSlug = String(val.slug || '')
        .trim()
        .toLowerCase();
      const derivedSlug = explicitSlug || (rawSub ? rawSub.replace(/^vtx-/, '') : '');
      const vertical = val.businessVertical || 'INDUMENTARIA_MODA';
      const mode = val.provisioningMode || 'FULL_DEMO';
      const subStatus = val.initialSubscriptionStatus || 'trial';
      const days = subStatus === 'trial' ? (val.trialDays ? Number(val.trialDays) : 14) : undefined;
      const payload = {
        ...val,
        slug: derivedSlug,
        subdomain: rawSub || undefined,
        desiredSubdomain: rawSub || undefined,
        verticalId: vertical,
        businessVertical: vertical,
        provisioningMode: mode,
        includeMockData: mode === 'FULL_DEMO',
        initialSubscriptionStatus: subStatus,
        trialDays: days,
      };
      const id = await this.storesService.createStore(
        payload as Parameters<typeof this.storesService.createStore>[0],
      );
      void this.router.navigate(['/stores', id]);
    } catch (error) {
      const raw = error instanceof Error ? error.message : '';
      const lower = raw.toLowerCase();
      let message = raw || 'No se pudo crear la tienda. Intentá de nuevo.';
      const errorCode = (error as { code?: string })?.code || '';
      if (
        lower === 'internal' ||
        lower.includes('functions/internal') ||
        errorCode === 'functions/internal' ||
        errorCode === 'internal'
      ) {
        message =
          'No se pudo conectar con el servicio de aprovisionamiento (error de red o permisos). Por favor reintentá en unos segundos.';
      } else if (lower.includes('permission-denied') || lower.includes('unauthenticated')) {
        message =
          'Tu sesión no tiene permisos de administrador de plataforma. Recargá la página y volvé a iniciar sesión.';
      } else if (
        lower.includes('quota') ||
        lower.includes('project count') ||
        lower.includes('exceeded')
      ) {
        message =
          'No hay cuota de proyectos GCP disponible para esta operación. Usá la tienda estándar (sin marcar "proyecto dedicado") o pedí el aumento de cuota de proyectos.';
      } else if (lower.includes('already exists') || lower.includes('ya existe')) {
        message = 'Ya existe una tienda con ese slug o nombre.';
      }
      this.errorMessage.set(message);
      this.isSubmitting.set(false);
    }
  }
}
