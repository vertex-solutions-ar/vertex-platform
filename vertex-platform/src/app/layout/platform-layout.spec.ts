import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { PlatformLayout, isDevHostname } from './platform-layout';
import { AuthService } from '@core/services/auth';
import { signal } from '@angular/core';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('firebase/firestore', () => {
  const unsubSpy = vi.fn();
  return {
    getFirestore: vi.fn(() => ({})),
    collection: vi.fn(() => ({})),
    onSnapshot: vi.fn(
      (
        _col: unknown,
        next: (snap: { forEach(cb: (d: { data(): { status?: string } }) => void): void }) => void,
      ) => {
        next({
          forEach: (cb) => {
            cb({ data: () => ({ status: 'open' }) });
            cb({ data: () => ({ status: 'resolved' }) });
          },
        });
        return unsubSpy;
      },
    ),
    __unsubSpy: unsubSpy,
  };
});

describe('PlatformLayout', () => {
  let fixture: ComponentFixture<PlatformLayout>;
  let component: PlatformLayout;
  let router: Router;

  const mockAuthService = {
    user: signal<{ email: string } | null>({ email: 'admin@vertex.com' }),
    isSuperAdmin: signal(true),
    logout: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    await TestBed.configureTestingModule({
      imports: [PlatformLayout],
      providers: [provideRouter([]), { provide: AuthService, useValue: mockAuthService }],
    }).compileComponents();

    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);

    fixture = TestBed.createComponent(PlatformLayout);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create layout component', () => {
    expect(component).toBeTruthy();
  });

  it('cuenta alertas abiertas desde el snapshot de firestore', () => {
    expect(component.openAlertsCount()).toBe(1);
  });

  it('libera la suscripción de alertas en ngOnDestroy', () => {
    expect(() => component.ngOnDestroy()).not.toThrow();
  });

  it('computes user initial from email', () => {
    expect(component.userInitial()).toBe('A');

    mockAuthService.user.set(null);
    expect(component.userInitial()).toBe('?');
  });

  it('toggles and closes sidebar', () => {
    expect(component.isSidebarOpen()).toBe(false);

    component.toggleSidebar();
    expect(component.isSidebarOpen()).toBe(true);

    component.closeSidebar();
    expect(component.isSidebarOpen()).toBe(false);
  });

  it('handles logout and navigates to login', async () => {
    await component.logout();
    expect(mockAuthService.logout).toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(['/login']);
  });

  it('closes sidebar on resize when window is large and keeps open when small', () => {
    component.isSidebarOpen.set(true);
    Object.defineProperty(window, 'innerWidth', { value: 1200, writable: true });
    component.onResize();
    expect(component.isSidebarOpen()).toBe(false);

    component.isSidebarOpen.set(true);
    Object.defineProperty(window, 'innerWidth', { value: 800, writable: true });
    component.onResize();
    expect(component.isSidebarOpen()).toBe(true);
  });

  it('handles closeSidebar when already closed and empty email in userInitial', () => {
    component.isSidebarOpen.set(false);
    component.closeSidebar();
    expect(component.isSidebarOpen()).toBe(false);

    mockAuthService.user.set({ email: '' });
    expect(component.userInitial()).toBe('?');
  });

  it('cierra el drawer con Escape', () => {
    component.isSidebarOpen.set(true);
    component.onEscape();
    expect(component.isSidebarOpen()).toBe(false);
  });

  it('no marca inert en desktop (la sidebar siempre es visible)', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1440, writable: true });
    component.onResize();
    expect(component.isDrawerMode()).toBe(false);
    expect(component.isSidebarInert()).toBe(false);
    expect(component.isMainInert()).toBe(false);
  });

  it('en modo drawer saca del tabulado la sidebar cerrada y el contenido abierto', () => {
    Object.defineProperty(window, 'innerWidth', { value: 800, writable: true });
    component.onResize();
    expect(component.isDrawerMode()).toBe(true);

    // Drawer cerrado: el nav no debe ser tabulable, el contenido sí.
    expect(component.isSidebarInert()).toBe(true);
    expect(component.isMainInert()).toBe(false);

    // Drawer abierto: al revés.
    component.isSidebarOpen.set(true);
    expect(component.isSidebarInert()).toBe(false);
    expect(component.isMainInert()).toBe(true);
  });
});

describe('isDevHostname', () => {
  it('marca localhost como DEV', () => {
    expect(isDevHostname('localhost')).toBe(true);
  });
  it('marca hosts web.app de desarrollo como DEV', () => {
    expect(isDevHostname('vertex-platform-dev.web.app')).toBe(true);
  });
  it('NO marca el host productivo vertex-platform-app como DEV', () => {
    expect(isDevHostname('vertex-platform-app.web.app')).toBe(false);
    expect(isDevHostname('vertex-platform-app')).toBe(false);
  });
  it('NO marca los hosts oficiales de produccion como DEV', () => {
    expect(isDevHostname('vertex-platform.web.app')).toBe(false);
    expect(isDevHostname('vertex-platform.firebaseapp.com')).toBe(false);
  });
  it('marca 127.0.0.1 y hosts .local como DEV', () => {
    expect(isDevHostname('127.0.0.1')).toBe(true);
    expect(isDevHostname('mi-host.local')).toBe(true);
  });
  it('marca hosts firebaseapp de desarrollo como DEV', () => {
    expect(isDevHostname('vertex-platform-dev.firebaseapp.com')).toBe(true);
  });
  it('maneja host vacío/desconocido como no-DEV', () => {
    expect(isDevHostname('')).toBe(false);
    expect(isDevHostname('ejemplo.com')).toBe(false);
  });
});
