import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { By } from '@angular/platform-browser';
import { vi } from 'vitest';
import { StoreCreate } from './store-create';
import type { RuntimeCapacitySummary } from '@core/services/stores';
import { StoresService } from '@core/services/stores';

import { signal } from '@angular/core';
import { PLATFORM_BUSINESS_VERTICALS } from '@core/constants/business-verticals.constants';

const runtimeSummary: RuntimeCapacitySummary = {
  environment: 'production',
  sharedShardCount: 1,
  activeSharedShardCount: 1,
  availableSharedSlots: 63,
  recommendedRuntimeMode: 'shared-shard',
  shards: [],
};

describe('StoreCreate', () => {
  const storesService = {
    createStore: vi.fn().mockResolvedValue('store-123'),
    getRuntimeCapacitySummary: vi.fn().mockResolvedValue(runtimeSummary),
    checkSubdomainAvailability: vi
      .fn()
      .mockResolvedValue({ available: true, sanitized: 'vtx-test' }),
    allVerticals: signal(PLATFORM_BUSINESS_VERTICALS),
    createCustomVertical: vi.fn().mockResolvedValue({ success: true, vertical: { id: 'TEST' } }),
  };

  beforeEach(async () => {
    storesService.createStore.mockReset();
    storesService.createStore.mockResolvedValue('store-123');
    storesService.checkSubdomainAvailability.mockReset();
    storesService.checkSubdomainAvailability.mockResolvedValue({
      available: true,
      sanitized: 'vtx-test',
    });
    storesService.getRuntimeCapacitySummary.mockReset();
    storesService.getRuntimeCapacitySummary.mockResolvedValue(runtimeSummary);

    await TestBed.configureTestingModule({
      imports: [StoreCreate],
      providers: [
        provideRouter([{ path: 'stores/:id', component: StoreCreate }]),
        { provide: StoresService, useValue: storesService },
      ],
    }).compileComponents();
  });

  it('auto-generates the slug and subdomain from the store name', () => {
    const fixture = TestBed.createComponent(StoreCreate);
    const component = fixture.componentInstance;

    component.form.patchValue({ name: 'Ropa Maria 2026' });
    component.autoSlug();

    expect(component.form.get('slug')?.value).toBe('ropa-maria-2026');
    expect(component.form.get('subdomain')?.value).toBe('vtx-ropa-maria-2026');
  });

  it('renders the runtime capacity summary when available', async () => {
    const fixture = TestBed.createComponent(StoreCreate);
    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();

    const summary = fixture.debugElement.query(By.css('[data-testid="runtime-summary"]'));
    expect(summary).not.toBeNull();
    expect(summary.nativeElement.textContent).toContain('63 lugares libres');
  });

  it('shows an error when runtime capacity lookup fails', async () => {
    storesService.getRuntimeCapacitySummary.mockRejectedValue(new Error('failed'));
    const fixture = TestBed.createComponent(StoreCreate);
    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'No se pudo cargar la capacidad actual de shared-shards.',
    );
  });

  it('normalizes unicode characters/accents in slug', () => {
    const fixture = TestBed.createComponent(StoreCreate);
    const component = fixture.componentInstance;

    component.form.patchValue({ name: 'Tienda de Café y Ñandúes' });
    component.autoSlug();

    expect(component.form.get('slug')?.value).toBe('tienda-de-cafe-y-nandues');
  });

  it('updates form when selecting vertical and provisioning mode', () => {
    const fixture = TestBed.createComponent(StoreCreate);
    const component = fixture.componentInstance;

    component.selectVertical('GASTRONOMIA_CAFE');
    expect(component.form.get('businessVertical')?.value).toBe('GASTRONOMIA_CAFE');
    expect(component.form.get('verticalId')?.value).toBe('GASTRONOMIA_CAFE');

    component.selectMode('CATALOG_ONLY');
    expect(component.form.get('provisioningMode')?.value).toBe('CATALOG_ONLY');
    expect(component.form.get('includeMockData')?.value).toBe(false);

    component.selectMode('FULL_DEMO');
    expect(component.form.get('provisioningMode')?.value).toBe('FULL_DEMO');
    expect(component.form.get('includeMockData')?.value).toBe(true);
  });

  it('submits correctly on valid form', async () => {
    storesService.createStore.mockResolvedValue('store-456');
    const fixture = TestBed.createComponent(StoreCreate);
    const component = fixture.componentInstance;

    component.form.patchValue({
      name: 'Mi Tienda',
      slug: 'mi-tienda',
      subdomain: 'vtx-mi-tienda',
      ownerEmail: 'owner@mitienda.com',
      businessVertical: 'INDUMENTARIA_MODA',
      provisioningMode: 'FULL_DEMO',
    });

    await component.onSubmit();

    expect(storesService.createStore).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Mi Tienda',
        slug: 'mi-tienda',
        subdomain: 'vtx-mi-tienda',
        ownerEmail: 'owner@mitienda.com',
        businessVertical: 'INDUMENTARIA_MODA',
        includeMockData: true,
      }),
    );
  });

  it('parses errors correctly on createStore failure', async () => {
    storesService.createStore.mockRejectedValue(new Error('Firebase error description'));
    const fixture = TestBed.createComponent(StoreCreate);
    const component = fixture.componentInstance;

    component.form.patchValue({
      name: 'Test Store',
      slug: 'test-store',
      subdomain: 'vtx-test-store',
      ownerEmail: 'owner@test.com',
      verticalId: 'indumentaria',
    });

    await component.onSubmit();
    fixture.detectChanges();

    expect(component.errorMessage()).toBe('Firebase error description');
    expect(component.isSubmitting()).toBe(false);
  });

  it('handles specific error scenarios gracefully', async () => {
    const fixture = TestBed.createComponent(StoreCreate);
    const component = fixture.componentInstance;

    component.form.patchValue({
      name: 'Test Store',
      slug: 'test-store',
      subdomain: 'vtx-test-store',
      ownerEmail: 'owner@test.com',
    });

    storesService.createStore.mockRejectedValueOnce(new Error('permission-denied'));
    await component.onSubmit();
    expect(component.errorMessage()).toContain('permisos de administrador');

    storesService.createStore.mockRejectedValueOnce(new Error('internal'));
    await component.onSubmit();
    expect(component.errorMessage()).toContain(
      'No se pudo conectar con el servicio de aprovisionamiento',
    );

    storesService.createStore.mockRejectedValueOnce(
      Object.assign(new Error('CORS fail'), { code: 'functions/internal' }),
    );
    await component.onSubmit();
    expect(component.errorMessage()).toContain(
      'No se pudo conectar con el servicio de aprovisionamiento',
    );

    storesService.createStore.mockRejectedValueOnce(new Error('quota exceeded for projects'));
    await component.onSubmit();
    expect(component.errorMessage()).toContain('cuota de proyectos GCP');

    storesService.createStore.mockRejectedValueOnce(new Error('Store already exists'));
    await component.onSubmit();
    expect(component.errorMessage()).toContain('Ya existe una tienda con ese slug');
  });

  it('immediately resets subdomain validation messages on short input', () => {
    const fixture = TestBed.createComponent(StoreCreate);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    component.subdomainAvailable.set(true);
    component.subdomainMessage.set('disponible');
    component.subdomainError.set('error');

    component.form.get('subdomain')?.setValue('ab');
    expect(component.subdomainAvailable()).toBeNull();
    expect(component.subdomainMessage()).toBe('');
    expect(component.subdomainError()).toBe('');
  });

  it('marks all touched on submit with invalid form', async () => {
    const fixture = TestBed.createComponent(StoreCreate);
    const component = fixture.componentInstance;

    component.form.patchValue({ name: '' }); // Invalid
    await component.onSubmit();

    expect(component.form.touched).toBe(true);
  });

  it('handles logo drag events and file validations', () => {
    const fixture = TestBed.createComponent(StoreCreate);
    const component = fixture.componentInstance;

    const mockEvent = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as DragEvent;

    component.onLogoDragOver(mockEvent);
    expect(component.isDraggingLogo()).toBe(true);

    component.onLogoDragLeave(mockEvent);
    expect(component.isDraggingLogo()).toBe(false);

    // Non-image file rejection
    const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });
    const dropEventInvalid = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      dataTransfer: { files: [textFile] },
    } as unknown as DragEvent;

    component.onLogoDropped(dropEventInvalid);
    expect(component.errorMessage()).toContain('archivo de imagen válido');

    // File over 2MB rejection
    const largeFile = new File([new ArrayBuffer(3 * 1024 * 1024)], 'huge.png', {
      type: 'image/png',
    });
    const dropEventLarge = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      dataTransfer: { files: [largeFile] },
    } as unknown as DragEvent;

    component.onLogoDropped(dropEventLarge);
    expect(component.errorMessage()).toContain('2MB');

    // Valid file selection
    const validFile = new File(['content'], 'logo.png', { type: 'image/png' });
    const selectEvent = {
      target: { files: [validFile] },
    } as unknown as Event;

    component.onLogoFileSelected(selectEvent);
    expect(component.logoFileName()).toBe('logo.png');

    // Remove logo
    component.removeLogo();
    expect(component.logoPreview()).toBeNull();
    expect(component.logoFileName()).toBe('');
    expect(component.form.get('logoUrl')?.value).toBe('');
  });

  it('allows customizing initial subscription modality and trial days', () => {
    const fixture = TestBed.createComponent(StoreCreate);
    const component = fixture.componentInstance;

    expect(component.form.get('initialSubscriptionStatus')?.value).toBe('trial');
    expect(component.form.get('trialDays')?.value).toBe(14);

    component.setInitialSubscription('complimentary');
    expect(component.form.get('initialSubscriptionStatus')?.value).toBe('complimentary');

    component.setInitialSubscription('trial', 30);
    expect(component.form.get('initialSubscriptionStatus')?.value).toBe('trial');
    expect(component.form.get('trialDays')?.value).toBe(30);

    component.setInitialSubscription('active');
    expect(component.form.get('initialSubscriptionStatus')?.value).toBe('active');

    // Test projectedTrialEndDate calculation
    component.form.patchValue({ trialDays: 10 });
    const projected = component.projectedTrialEndDate();
    const expectedDiffDays = Math.round((projected.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    expect(expectedDiffDays).toBe(10);

    // Test onCustomTrialDaysChange validation (clamp min 1, max 365)
    component.onCustomTrialDaysChange({ target: { value: '0' } } as unknown as Event);
    expect(component.form.get('trialDays')?.value).toBe(1);

    component.onCustomTrialDaysChange({ target: { value: '-5' } } as unknown as Event);
    expect(component.form.get('trialDays')?.value).toBe(1);

    component.onCustomTrialDaysChange({ target: { value: '45' } } as unknown as Event);
    expect(component.form.get('trialDays')?.value).toBe(45);

    component.onCustomTrialDaysChange({ target: { value: '999' } } as unknown as Event);
    expect(component.form.get('trialDays')?.value).toBe(365);
  });

  it('onSubmit does not call createStore if form is invalid', async () => {
    const fixture = TestBed.createComponent(StoreCreate);
    const component = fixture.componentInstance;
    component.form.patchValue({ name: '' });
    await component.onSubmit();
    expect(storesService.createStore).not.toHaveBeenCalled();
  });

  it('onSubmit calls createStore when form is valid and handles error', async () => {
    const fixture = TestBed.createComponent(StoreCreate);
    const component = fixture.componentInstance;
    component.form.patchValue({
      name: 'Tienda Test',
      slug: 'tienda-test',
      subdomain: 'vtx-tienda-test',
      ownerEmail: 'test@example.com',
      verticalId: 'TECNOLOGIA',
      provisioningMode: 'FULL_DEMO',
      dedicatedProject: false,
    });

    await component.onSubmit();
    expect(storesService.createStore).toHaveBeenCalled();

    storesService.createStore.mockRejectedValueOnce(new Error('Creation failed'));
    await component.onSubmit();
    expect(component.errorMessage()).toBe('Creation failed');
  });

  it('onCustomVerticalCreated updates vertical value in form', () => {
    const fixture = TestBed.createComponent(StoreCreate);
    const component = fixture.componentInstance;
    component.onCustomVerticalCreated({
      id: 'CUSTOM_RUBRO',
      name: 'Custom Rubro',
      icon: '✨',
      description: 'Desc',
      categories: [],
    });
    expect(component.form.get('verticalId')?.value).toBe('CUSTOM_RUBRO');
    expect(component.showCustomVerticalModal()).toBe(false);
  });
});
