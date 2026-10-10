# UX Guidelines — Vertex Platform

Estándares de estados de carga y feedback del panel SaaS.

## Reglas generales

1. **Todo botón que dispara una operación async** debe:
   - Deshabilitarse mientras corre (`[disabled]="isX()"`).
   - Mostrar un `<span class="spinner-sm"></span>` + texto en progreso ("Guardando…",
     "Desplegando…", etc.).
2. **Listas y datos bajo demanda** deben mostrar un **skeleton** mientras cargan
   (no "vacío" prematuro). Ver `stores-list` → `stores.isLoading()`.
3. **Errores** siempre visibles cerca de la acción (`.feedback--error`), con `errorMessage()`
   de `@core/utils/error.util`.
4. **Éxitos** confirmados con `.feedback--success` (ej. "Actualización a v0.2.0 iniciada…").
5. **Modales destructivos** requieren confirmación con el valor exacto (ej. el projectId)
   y spinner en el botón de confirmar.

## Inventario de estados de carga (store-detail)

| Acción                                  | Signal                                           | Spinner                |
| --------------------------------------- | ------------------------------------------------ | ---------------------- |
| Reintentar aprovisionamiento            | `isRetrying`                                     | ✅                     |
| Eliminar tienda                         | `isDeleting`                                     | ✅                     |
| Auto-update toggle                      | `isUpdatingAutoUpdate`                           | ✅                     |
| Cargar versiones disponibles            | `isLoadingVersions`                              | ✅ (texto)             |
| Cargar ramas para el selector de fuente | `isLoadingBranches`                              | ✅ (skeleton)          |
| Aplicar versión                         | `isUpdatingVersion`                              | ✅ "Iniciando deploy…" |
| Re-desplegar versión activa             | `isRedeploying`                                  | ✅ "Desplegando…"      |
| Desplegar rama / commit (prueba)        | `pendingDeploy` (confirmación) + `deploy.isBusy` | ✅ modal + spinner     |
| Volver a release estable                | `deploy.isBusy`                                  | ✅ spinner             |
| Habilitar despliegues de prueba         | `isUpdatingAllowTest`                            | ✅ spinner             |
| Semillar datos                          | `isSeeding`                                      | ✅                     |
| Dormir/activar tienda                   | `isSuspending`                                   | ✅ (modal)             |
| Cargar config                           | `isLoadingConfig`                                | ✅ spinner             |
| Guardar ajustes reactivos               | `isSavingConfig`                                 | ✅                     |
| Cargar staff                            | `isLoadingStaff`                                 | ✅                     |
| Enviar invitación                       | —                                                | ✅                     |
| Vincular dominio                        | `isConnectingDomain`                             | ✅                     |

## Listas

- `stores-list`: skeleton shimmer mientras `StoresService.isLoading()` (primer snapshot).

## Patrón skeleton (SCSS)

```scss
.skeleton {
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0.06) 25%,
    rgba(255, 255, 255, 0.14) 50%,
    rgba(255, 255, 255, 0.06) 75%
  );
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.4s ease-in-out infinite;
}
@keyframes skeleton-shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}
```

## Spinner reutilizable `<app-spinner>`

Componente `AppSpinnerComponent` (`src/app/shared/components/app-spinner/`):

- **3 tamaños**: `sm` (0.9rem), `md` (1.35rem), `lg` (2.2rem).
- **Animación continua y detallada**: anillos concéntricos girando en direcciones
  opuestas + núcleo pulsante (solo `lg`).
- **Label opcional** accesible (`aria-label` + texto visible).

```html
<app-spinner size="sm" label="Reintentando…" />
<app-spinner size="lg" label="Aprovisionando tienda…" />
```

Se usa en: pasos de aprovisionamiento en ejecución, y botones de
retry / aplicar versión / redeploy / seed / suspender.

## Verificación de versión desplegada (bundle)

La versión se hornea en el bundle al compilar (`package.json` del tag/commit checkouteado),
NO se lee en runtime:

```bash
MAIN=$(curl -s https://vtx-<tienda>.web.app/ | grep -oE 'main-[A-Z0-9]+\.js' | head -1)
curl -s https://vtx-<tienda>.web.app/$MAIN | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1
```

Si el bundle contiene la versión esperada, el deploy proviene de ese tag. Verificar
también `window.__VERTEX_STORE_VERSION__`, el `<meta name="app-version">` y
`appVersion` en `stores/{storeId}` — los tres coinciden con el mismo build.

Para deploys de prueba (rama/commit) la verificación es la procedencia, no la versión:
`assets/version.json` expone `sourceKind` / `sourceRef` / `commitSha`, y la tienda guarda
`deploySource` + `lastDeployedCommit`. El detalle está en `agent.md` → _Fuente de Despliegue_.
