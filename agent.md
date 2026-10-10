# Universal Agent Rules — Platform (`vertex-platform`)

This file contains instructions for AI agents and developers working on the Platform repository.

---

## 🏗️ Arquitectura del Monorepo

```
platform/
├── vertex-platform/          # App Angular + Cloud Functions
│   ├── src/app/              # Frontend Angular 22+ (Signals, Standalone, Clean Naming)
│   └── functions/src/        # Cloud Functions v2 (TypeScript)
│       ├── provisioning.ts   # Aprovisionamiento y ciclo de vida de tiendas
│       ├── versioning.ts     # Gestión de versiones del template
│       ├── stores.ts         # CRUD de tiendas y helpers
│       ├── auth.ts           # Autenticación y roles
│       └── index.ts          # Entry point — exports de todas las functions
├── packages/
│   └── shared-contracts/     # @vertex/contracts — esquemas Zod compartidos
└── scripts/                  # Orquestación de dev local
```

---

## 💻 Comandos de desarrollo

```bash
# Desde platform/
npm run start                            # Orquestador E2E con hot-reload
bash docker/start.sh                     # Stack Docker completo

# Tests (272 tests totales — 100% pasando)
npm test                                 # 197 Frontend + 75 Backend (Vitest + ng test)
npm run test:backend                     # Backend (Vitest con cobertura) — 75 tests
npm run test:frontend                    # Frontend (ng test con cobertura) — 197 tests

# Build
npm run build                            # Build monorepo completo (Frontend + Functions)

# QA & Security
npm run lint                             # Linting
npm run typecheck                        # TypeScript strict
npm run qa:global                        # Lint + typecheck + firestore rules
npm audit                                # Verificación 0 vulnerabilidades
```

---

## 🧪 Política Obligatoria de Cobertura de Código (Quality Gate ≥95%, 100% Ideal)

- **Umbral Mínimo No Modificable**: La cobertura de código en Platform debe ser estrictamente **$\ge 95\%$ en todas las 4 métricas**:
  1. `Statements` $\ge 95\%$
  2. `Branches` $\ge 95\%$
  3. `Functions` $\ge 95\%$
  4. `Lines` $\ge 95\%$
  - **100%** es el objetivo ideal permanente para toda nueva lógica y componentes.
- **Bloqueo en Hooks Locales (`pre-commit` y `pre-push`)**: Los hooks de Husky ejecutan `npm test` y `node vertex-platform/scripts/verify-coverage.js`. No se permite realizar `git commit` ni `git push` si cualquiera de los porcentajes es menor a 95%.
- **Bloqueo en CI/CD**: `ci.yml` ejecuta la misma verificación y rechaza automáticamente PRs que no alcancen el 95%.

---

## 🔄 Git Flow & PR Governance

- Ramas: `develop` (dev/staging) y `main` (prod)
- Feature branches: `feat/*`, `fix/*`, `chore/*` desde `develop`
- Direct push bloqueado por server-side rules
- Bypass Husky local:
  ```bash
  HUSKY=0 git commit -m "..." && HUSKY=0 git push origin branch-name
  ```

---

## 🔢 Versionado de la Plataforma

Versión actual: `0.8.0` (Template: `0.8.0`, Platform: `0.8.0`)

La constante `CURRENT_TEMPLATE_VERSION` en `provisioning.ts` define qué versión del storefront
se usa al provisionar nuevas tiendas.

**NO editar manualmente.** Se actualiza automáticamente vía PR generado por `sync-template-version.yml`
cuando el storefront publica un nuevo release.

### Flujo automático

1. Storefront hace `npm run release:minor` → tag `v0.8.0`
2. Workflow `release.yml` del storefront dispara `repository_dispatch: storefront-release`
3. Workflow `sync-template-version.yml` de la plataforma abre PR automático
4. Admin de plataforma revisa y mergea el PR

---

## 📖 Regla de Oro: Mantenimiento Obligatorio de Documentación

**Toda tarea, bugfix, cambio de infraestructura o evolución arquitectónica DEBE mantener la documentación sincronizada antes de darse por finalizada.**

1. **Actualización Inmediata**: Al modificar flujos, reglas, modelos o CI/CD, actualizar de inmediato los documentos correspondientes (`agent.md`, `README.md`, `ARCHITECTURE.md`, y `.agents/AGENTS.md` en la raíz).
2. **Cero Desincronización**: Las versiones en la documentación deben coincidir con `package.json` y `CURRENT_TEMPLATE_VERSION`.
3. **Documentación como Criterio de Aceptación (DoD)**: Un PR o desarrollo NO se considera terminado si no incluye la actualización de su respectiva documentación técnica y operacional.

---

## 🚀 Ciclo de Vida de Canales de Preview Efímeros (PR Previews)

- **Creación en PR**: Al abrir o actualizar un PR hacia `develop`, el workflow `ci.yml` despliega un canal efímero en Firebase Hosting (`vertex-platform-dev--pr-XXX.web.app`).
- **CORS para Cloud Functions**: `ALLOWED_ORIGINS` en `helpers.ts` incluye expresiones regulares (`RegExp`) para admitir automáticamente las peticiones de cualquier canal de preview sin errores de CORS.
- **Destrucción Automática y Feedback**: Al cerrar o mergear el PR, `preview-cleanup.yml`:
  1. Elimina el canal en Firebase Hosting (pasa a dar 404).
  2. Limpia los datos de prueba en Firestore.
  3. Publica un comentario de confirmación en el PR: `🗑️ Instancia de Preview Eliminada`.
  4. Elimina automáticamente la rama remota de la PR.

---

## 🔄 Fuente de Despliegue (Release vs Prueba, sin tag nuevo)

El panel de detalle de la tienda (`/stores/:id` > tab **Orquestación**) tiene un único
selector de **fuente de despliegue** con tres modos:

| Modo      | `gitRef` despachado                      | Guards                                                    |
| --------- | ---------------------------------------- | --------------------------------------------------------- |
| `release` | `refs/tags/vX.Y.Z`                       | Ninguno. Único modo admitido en tiendas de producción.    |
| `branch`  | nombre de rama (ej. `develop`, `feat/x`) | Sólo tiendas development, o `allowTestDeployments: true`. |
| `commit`  | SHA de 7–40 hex                          | Idem `branch`.                                            |

Reglas del contrato (implementadas en `functions/src/deployment-source.ts`):

- **Validación obligatoria**: `redeployStore` resuelve el ref contra la API de GitHub
  (`GET /repos/{repo}/commits/{ref}`) _antes_ de despachar. Si no existe, falla con un
  mensaje claro y la tienda **no** queda en `deploying`.
- **`redeployStore` acepta** `{ storeId, source?: { kind, value } }`. La forma legacy
  `ref: string` sigue soportada (equivale a `{ kind: 'branch' }`) pero está **deprecada**.
- **Una sola ruta de despacho**: `dispatchStoreDeployment(storeId, source)` con `source`
  obligatorio, compartida por `redeployStore` y `activateStore`. La política de refs vive en
  `resolveDefaultDeploySource`, no duplicada.
- **Las 9 propiedades raíz** del `client_payload` se mantienen intactas (ver #403). La
  procedencia viaja dentro de `meta`: `source_kind`, `source_ref`, `source_sha`.
- **`listTemplateRefs`** devuelve `{ defaultBranch, branches[], releases[] }` (cache 60 s) para
  que el selector ofrezca ramas reales en lugar de texto libre.
- **`activateStore` reusa `deploySource`**: reactivar una tienda en canal de prueba la
  re-despliega en esa misma fuente; no la resetea en silencio a stable.
- **Trazabilidad veraz**: `stores/{storeId}` guarda `deploySource {kind, ref, gitRef, commitSha,
commitMessage, status, requestedAt, requestedBy}` y `lastDeployedCommit`. `targetChannel`
  pasa a `test`/`stable` según la fuente. `templateVersion` **no se toca** en deploys de
  prueba: sigue siendo la release estable de referencia.
- **Historial real**: `completeStoreDeployment` / `completeVersionUpdate` aceptan
  `sourceKind` / `sourceRef` / `sourceSha` (informativos) y el historial registra el ref y el
  SHA **realmente compilados**, no `github.ref` (que en un `repository_dispatch` siempre es la
  rama por defecto). El campo `ref` sigue siendo el ref del workflow porque es contra el que se
  valida el claim OIDC — la autenticación no se debilitó.

### Metadata del bundle (repo storefront)

- `scripts/generate-build-info.js` agrega `sourceKind` y `sourceRef` a `BUILD_INFO` y a
  `src/assets/version.json`, leyendo `DEPLOY_SOURCE_KIND` / `DEPLOY_SOURCE_REF`.
- `deploy.yml` (job `provision-store`) resuelve la procedencia con `git rev-parse HEAD` tras el
  checkout (`github.sha` **no** sirve en `repository_dispatch`) y la reporta a la plataforma.
- `src/main.ts` expone `window.__VERTEX_STORE_SOURCE__` y los `<meta name="app-source-ref">` /
  `<meta name="app-source-kind">` para verificar desde el sitio qué se compiló.

### Promoción a release

El panel **no** crea tags automáticamente. Un tag `vX.Y.Z` dispara `release.yml` →
`create-release` (que falla si `package.json` del commit no coincide con el tag) →
`sync-template-version.yml` (PR de bump) y `Deploy All Stores` (re-despliegue de **todas** las
tiendas). Por eso la promoción es **asistida**: el panel muestra la rama y el commit validados
y un enlace a GitHub para publicar la release con el flujo estándar (`npm run release:*`).

---

## 🧹 Política de Higiene del Repositorio (Clean Repo Policy)

- **Archivos Prohibidos en Git**: Jamás commitear carpetas temporales de IDEs (`.antigravitycli/`, `.gemini/`, `.claude/`, `.cursor/`), logs (`firestore-debug.log`, `firebase-debug.log`, `*.log`), credenciales `.env`, ni datos locales de emuladores (`emulator-data/`).
- **Verificación**: Siempre verificar con `git status` y `.gitignore` antes de hacer commit.

---

## 🔥 Cloud Functions — Patterns críticos

### Inicialización de clientes (GCP SDK)

```typescript
// ✅ CORRECTO: cliente en scope global (evita re-init latency)
const secretClient = new SecretManagerServiceClient();
export { secretClient };

// ❌ INCORRECTO: dentro de la función
export const myFunction = onCall(async () => {
  const client = new SecretManagerServiceClient(); // NO
});
```

### Caching en memoria

```typescript
// Cache secrets para evitar llamadas repetidas a GCP
const secretCache = new Map<string, string>();
```

### Recursos de Functions

- `provisionStore`, `runProvisioning`: `512MiB` / `300s` timeout
- Resto: defaults

### Runtime de Cloud Functions

- **Versión de Node.js**: Debe ser **Node.js 22** (`"engines": { "node": "22" }` en `package.json` de functions).
  - _Razón_: La plataforma contiene Cloud Functions heredadas de Generación 1 (como `onPlatformUserCreated` y `reconcileActiveStores`), las cuales no son compatibles con Node.js 24. El uso de Node.js 22 es compatible con ambas generaciones (Gen 1 y Gen 2).

### Estrategia de Caché en Hosting

- **Cabeceras de Control**: Se debe configurar `Cache-Control` en el archivo `firebase.json` de Hosting aplicando por defecto la regla `no-cache, no-store, must-revalidate` a todas las rutas (`"source": "**"`).
  - _Razón_: Al ser una Single Page Application (SPA), las solicitudes a rutas limpias del lado del cliente (ej. `/stores`) son reescritas a `/index.html` internamente. Si no se asocia `no-cache` a todas las rutas (`**`), Firebase servirá el punto de entrada con almacenamiento en caché por defecto del navegador/CDN (ej. `max-age=3600`), previniendo que los usuarios vean actualizaciones inmediatas tras un deploy. Los recursos estáticos con huella digital en sus nombres (JS, CSS, tipografías) sí se deben cachear permanentemente (`public, max-age=31536000, immutable`).

---

## 🏬 Motor de Rubros Comerciales Dinámicos, Buscador y Paginador de Cards

- **Catálogo Centralizado & Custom Verticals**:
  - 21 presets nativos modulares ubicados en `functions/src/verticals/presets/*.ts`, cada uno con más de 20 productos detallados, variantes realistas, paleta de colores y USPs únicas.
  - **Sistema de Creación de Rubros Custom (`CustomVerticalModal`)**: Modal flotante centrado con Glassmorphism (`position: fixed; inset: 0; z-index: 10000`), preview en vivo de marca, selector rápido de emojis y listado de chips interactivos. Permite registrar nuevos rubros en `business_verticals/{id}` vía `createCustomVertical`.
  - **Resolución Dinámica**: `getBusinessVerticalPresetAsync(verticalId)` resuelve presets nativos y consulta Firestore en tiempo real para rubros customizados, generando dinámicamente el catálogo y configuración iniciales.
- **Componente Reutilizable `RubroSelector` (`@shared/components/rubro-selector/`)**:
  - **Buscador en Tiempo Real**: Filtra instantáneamente por nombre, descripción, ID o categorías asociadas, con botón de limpieza (`✕`).
  - **Paginador Moderno**: 6 cards por página (configurable con `pageSize`), botones de navegación Anterior/Siguiente, píldoras numéricas de página y contador resumen (`1-6 de 21`).
  - **Estética Glassmorphism Premium**: Bordes degradados, halo de selección púrpura/cian, micro-animaciones en hover y accesibilidad completa por teclado (`Enter`/`Space`/`Escape`).
- **Modalidades de Aprovisionamiento (`provisioningMode`)**:
  - `EMPTY`: Crea únicamente los singletons de configuración (`configuracion/store_{storeId}`, `footer_{storeId}`, `pages/home_{storeId}`, `aboutUs_{storeId}`). Deja catálogo, clientes y pedidos en 0 documentos.
  - `CATALOG_ONLY`: Inyecta 20+ productos con categorías (`{storeId}-cat-{slug}`), atributos (`{storeId}-attr-{code}`), variantes y stock real. 0 clientes y 0 órdenes.
  - `FULL_DEMO`: Inyecta catálogo completo (20+ productos) + 8 clientes simulados con historial + 8-10 órdenes históricas correlacionadas con diversos estados (`delivered`, `shipped`, `processing`, `pending`, `ready_for_pickup`), métodos de pago (Mercado Pago, transferencia), opciones de envío y retiro en showroom, paleta de colores corporativa y USPs personalizadas.

### 👥 Gestión de Equipo e Invitaciones Multi-Tenant

- **Recarga Reactiva**: `StoreDetailStaffService.sendInvitation` y la selección de la pestaña `equipo` en `StoreDetail` recargan las listas de staff e invitaciones con `force: true`.
- **Sincronización Automática de Aceptación**: `getStoreStaff` consulta `admin_roles` del shard por `tenantId` y claves compuestas, actualizando el estado de invitaciones pendientes a `accepted` cuando el invitado ya ha ingresado o existe en el shard.

### 💳 Motor de Suscripciones SaaS, Selector de Trial y QA Lab

- **Selector de Trial en Creación**: Grid interactivo en `StoreCreate` con presets de 7, 14 (recomendado), 30 días y opción personalizada, proyectando en tiempo real la fecha exacta de expiración y avisando sobre los 5 días de gracia.
- **Período de Gracia & Recargo por Mora (2% Diario)**: Si una tienda no abona a su fecha de vencimiento, entra en período de gracia de 5 días (`past_due`). Se computa un recargo del **2% diario acumulativo por cada día transcurrido** (hasta 10% al día 5) sobre el importe base. Al exceder los 5 días, la tienda se suspende de forma automática y requiere regularizar con el 10% de recargo. El desglose se detalla de forma transparente en el checkout público (`/pay/:id`) y en el tab Pagos de la tienda (`/stores/:id`).
- **Herramientas de Simulación / QA Lab (DEV y PROD)**: Disponible en `/stores/:id` (tab Pagos) para Master Admins mediante un panel colapsable discreto. Permite simular:
  - Expira en 1 hora (`imminent`).
  - En período de gracia (`grace_period`, vencido hace 2 días, aplicando 4% de mora).
  - Suspensión preventiva (`expired_suspended`, vencido hace 7 días, aplicando 10% de mora).
  - Restablecer período de prueba (`reset_trial`, 14 días limpios).
- **Manejo Resiliente de Fechas**: `parseDateToMillis` y `formatDateUtil` aceptan instancias Date, Timestamps con `.toDate()`, `{ seconds }`, `{ _seconds }` o strings ISO, evitando `TypeError` en Angular.

---

## 🛡️ Acceso y Permisos

| Componente                 | Acceso                                          |
| -------------------------- | ----------------------------------------------- |
| Plataforma admin dashboard | Solo: `juanson-espeche`, `lihue`, cuenta Vertex |
| Storefront `/shop`         | Público                                         |
| Storefront `/admin`        | Admin autorizado en `admin_roles/{email}`       |

### Administradores de plataforma autorizados

- `juanson-espeche` (owner)
- `lihue` (admin)
- Cuenta `vertex` (service account)

---

## 📋 Entornos Firebase

| Entorno         | Proyecto Firebase      | URL                                  |
| --------------- | ---------------------- | ------------------------------------ |
| Platform DEV    | `vertex-platform-dev`  | https://vertex-platform-dev.web.app  |
| Platform PROD   | `vertex-platform-app`  | https://vertex-platform-app.web.app  |
| Storefront DEV  | `ecommerce-vertex-dev` | https://ecommerce-vertex-dev.web.app |
| Storefront PROD | `ecommerce-vertex`     | https://ecommerce-vertex.web.app     |

---

## ⚠️ Patrones a evitar

- **NO** crear `getStoreDeploymentHistory` ni similar — fue removido por generar hasta 50 llamadas a GitHub por carga de vista
- **NO** usar `setInterval` para polling en componentes Angular; usar `toSignal` o RxJS
- **NO** editar `CURRENT_TEMPLATE_VERSION` manualmente — el workflow lo gestiona
- **NO** hardcodear versiones de template fuera de `provisioning.ts`
- **NO** invalidar `authDomain` en `shared-shard` sobreescribiéndolo a `{projectId}.firebaseapp.com`
- **Sincronización de custom claims**: Utilizar la callable `refreshMyPlatformAdminClaim` al iniciar sesión en el storefront para refrescar tanto `platformAdmin` como `admin`/`tenantId`/`role` consultando la colección `admin_roles`.
- **Aprovisionamiento Automático de Permisos IAM en Shards**: El aprovisionador de la plataforma (`ensureShardProjectIam` en `provisioning.ts`) asigna automáticamente de forma transparente en cada shard los roles `roles/datastore.user`, `roles/owner`, `roles/editor`, `roles/firebasehosting.admin` y `roles/firebaserules.admin` a todas las Service Accounts de ejecucion del sistema, incluyendo las Service Accounts de 2da generación de Cloud Run (`PROJECT_NUMBER-compute@developer.gserviceaccount.com`). Esto permite el acceso backend directo al Firestore de cada tienda sin intervención manual.

---

## 🔗 Repositorios relacionados

- **Platform**: `https://github.com/vertex-solutions-ar/vertex-platform`
- **Storefront**: `https://github.com/vertex-solutions-ar/ecommerce-vertex`
- Ambos bajo la org `vertex-solutions-ar`
