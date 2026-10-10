import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '@core/services/auth';

@Component({
  selector: 'app-login',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="login-page">
      <div class="card-wrapper">
        <div class="login-card">
          <div class="card-header">
            <h1 class="card-title">Vertex Platform</h1>
            <p class="card-sub">Panel de gestión de tiendas</p>
          </div>

          <div class="card-body">
            @if (auth.authError() === 'unauthorized') {
              <div class="alert">
                <i class="bi bi-shield-exclamation"></i>
                <div>
                  <strong>Acceso denegado.</strong> Tu cuenta no tiene permisos. Contactá al
                  administrador.
                </div>
              </div>
            } @else if (auth.authError() === 'popup-blocked') {
              <div class="alert">
                <i class="bi bi-exclamation-triangle"></i>
                <div>
                  El popup fue bloqueado. Permití popups para este sitio e intentá de nuevo.
                </div>
              </div>
            } @else if (auth.authError() === 'unknown') {
              <div class="alert">
                <i class="bi bi-exclamation-triangle"></i>
                <div>
                  Error al iniciar sesión. Intentá de nuevo.
                  @if (auth.authErrorCode()) {
                    <br /><small class="login-error-code">{{ auth.authErrorCode() }}</small>
                  }
                </div>
              </div>
            }

            <button type="button" class="btn-google" (click)="login()">
              <svg width="18" height="18" viewBox="0 0 48 48">
                <path
                  fill="#EA4335"
                  d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                />
                <path
                  fill="#4285F4"
                  d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                />
                <path
                  fill="#FBBC05"
                  d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                />
                <path
                  fill="#34A853"
                  d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.34-8.16 2.34-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                />
              </svg>
              Continuar con Google
            </button>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      @keyframes gradient-shift {
        0% {
          background-position: 0% 50%;
        }
        50% {
          background-position: 100% 50%;
        }
        100% {
          background-position: 0% 50%;
        }
      }

      .login-page {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
        background-color: #080b14;
        background-image:
          radial-gradient(circle at 20% 30%, rgba(30, 58, 138, 0.15) 0%, transparent 50%),
          radial-gradient(circle at 80% 70%, rgba(88, 28, 135, 0.12) 0%, transparent 50%);
      }

      .card-wrapper {
        padding: 2px;
        border-radius: 16px;
        background: linear-gradient(135deg, #0284c7, #4f46e5, #0284c7);
        background-size: 200% 200%;
        animation: gradient-shift 8s ease infinite;
        box-shadow:
          0 8px 40px rgba(79, 70, 229, 0.25),
          0 2px 12px rgba(0, 0, 0, 0.5);
        width: 100%;
        max-width: 400px;
      }

      .login-card {
        background: #0d1117;
        border-radius: 14px;
        overflow: hidden;
      }

      .card-header {
        padding: 2rem 2.5rem 1.5rem;
        border-bottom: 1px solid rgba(255, 255, 255, 0.07);
        text-align: center;
      }

      .card-title {
        font-size: 1.75rem;
        font-weight: 700;
        margin: 0 0 0.375rem;
        background: linear-gradient(135deg, #0284c7, #4f46e5);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }

      .card-sub {
        color: rgba(148, 163, 184, 0.7);
        margin: 0;
        font-size: 0.875rem;
      }

      .card-body {
        padding: 1.75rem 2.5rem 2.25rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }

      .alert {
        display: flex;
        align-items: flex-start;
        gap: 0.75rem;
        background: rgba(220, 38, 38, 0.1);
        border: 1px solid rgba(220, 38, 38, 0.25);
        color: #fca5a5;
        border-radius: 8px;
        padding: 0.75rem 1rem;
        font-size: 0.875rem;
        line-height: 1.5;

        i {
          font-size: 1rem;
          flex-shrink: 0;
          padding-top: 0.1rem;
        }
      }

      .btn-google {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
        width: 100%;
        padding: 0.875rem 1.5rem;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.04);
        color: #f1f5f9;
        font-size: 0.95rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;

        &:hover {
          background: rgba(255, 255, 255, 0.08);
          border-color: rgba(255, 255, 255, 0.18);
          transform: translateY(-1px);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        }
      }

      /* Código de error de autenticación (antes un style inline con opacity). */
      .login-error-code {
        opacity: 0.7;
      }
    `,
  ],
})
export class Login {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  async login(): Promise<void> {
    await this.auth.loginWithGoogle();
    if (this.auth.isLoggedIn()) {
      void this.router.navigate(['/stores']);
    }
  }
}
