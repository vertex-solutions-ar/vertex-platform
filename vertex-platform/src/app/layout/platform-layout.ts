import {
  ChangeDetectionStrategy,
  type OnInit,
  type OnDestroy,
  Component,
  HostListener,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '@core/services/auth';
import { getFirestore, collection, onSnapshot } from 'firebase/firestore';
import { ThemeService } from '@core/services/theme.service';

/** Hosts oficiales de producción de la plataforma (nunca DEV). */
const PROD_HOSTS = new Set([
  'vertex-platform.web.app',
  'vertex-platform-app.web.app',
  'vertex-platform.firebaseapp.com',
]);

/** Entorno no productivo: localhost o hosts web.app/firebaseapp.com de desarrollo. */
export function isDevHostname(host: string): boolean {
  if (!host) {
    return false;
  }
  const h = host.toLowerCase();
  if (PROD_HOSTS.has(h)) {
    return false;
  }
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h.endsWith('.local') ||
    h.includes('-dev.web.app') ||
    h.includes('-dev.firebaseapp.com') ||
    h.includes('dev.')
  );
}

@Component({
  selector: 'app-platform-layout',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './platform-layout.html',
  styleUrl: './platform-layout.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlatformLayout implements OnInit, OnDestroy {
  readonly auth = inject(AuthService);
  readonly theme = inject(ThemeService);
  private readonly router = inject(Router);
  readonly isSidebarOpen = signal(false);

  /** Entorno no productivo (localhost o host de dev/web.app que no sea vertex-platform-app).
   *  La lógica vive en isDevHostname() (cubierta por unit tests); esta línea solo
   *  delega el hostname actual del navegador. */
  /* istanbul ignore next */
  readonly openAlertsCount = signal(0);
  private alertUnsub: (() => void) | null = null;

  readonly isDevEnv: boolean = isDevHostname(
    typeof window !== 'undefined' ? window.location.hostname : '',
  );

  readonly userInitial = computed(() => {
    const email = this.auth.user()?.email ?? '';
    return (email[0] ?? '?').toUpperCase();
  });

  private readonly breakpointLg = 1024;

  /**
   * ¿La sidebar está en modo drawer (off-canvas)?
   * Por debajo del breakpoint la navegación está oculta, así que hay que sacarla del
   * orden de tabulación cuando está cerrada; en desktop la sidebar siempre es visible
   * y **no** debe marcarse `inert` (rompería la navegación).
   */
  readonly isDrawerMode = signal(false);

  /** La sidebar está fuera de pantalla: no debe ser tabulable. */
  readonly isSidebarInert = computed(() => this.isDrawerMode() && !this.isSidebarOpen());

  /** El contenido está dimmed detrás del drawer: no debe ser tabulable. */
  readonly isMainInert = computed(() => this.isDrawerMode() && this.isSidebarOpen());

  private syncDrawerMode(): void {
    /* istanbul ignore next: entorno sin window (SSR/tests) */
    const width = typeof window !== 'undefined' ? window.innerWidth : 0;
    this.isDrawerMode.set(width <= this.breakpointLg);
  }

  toggleSidebar(): void {
    this.isSidebarOpen.update((v) => !v);
  }

  closeSidebar(): void {
    if (this.isSidebarOpen()) {
      this.isSidebarOpen.set(false);
    }
  }

  ngOnInit(): void {
    this.syncDrawerMode();
    try {
      this.alertUnsub = onSnapshot(
        collection(getFirestore(), 'alerts'),
        (snap) => {
          let open = 0;
          snap.forEach((d) => {
            const data = d.data() as { status?: string };
            if (data.status === 'open') {
              open += 1;
            }
          });
          this.openAlertsCount.set(open);
        },
        () => {
          /* silencioso: sin permisos no se muestra contador */
        },
      );
    } catch {
      /* entorno sin Firebase (tests/layout) no debe romper */
    }
  }

  ngOnDestroy(): void {
    if (this.alertUnsub) {
      this.alertUnsub();
    }
  }

  async logout(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/login']);
  }

  /** `Esc` cierra el drawer: antes sólo se podía cerrar con click en el backdrop. */
  @HostListener('window:keydown.escape')
  onEscape(): void {
    this.closeSidebar();
  }

  @HostListener('window:resize')
  onResize(): void {
    this.syncDrawerMode();
    if (window.innerWidth > this.breakpointLg) {
      this.isSidebarOpen.set(false);
    }
  }
}
