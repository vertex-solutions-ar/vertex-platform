# Arquitectura — Vertex Platform (Plano de Control SaaS)

## Visión General

**Vertex Solutions** opera un ecosistema SaaS multi-tenant de comercio electrónico compuesto por dos repositorios hermanos:

| Repositorio                         | Rol                                                              | Stack                                                          |
| ----------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| `vertex-solutions-ar/vertex-platform`  | Plano de control (aprovisionamiento, billing, shards, contratos) | Angular 22 + Firebase Cloud Functions v2 + Firestore           |
| `vertex-solutions-ar/ecommerce-vertex` | Plantilla de tienda (storefront + admin del cliente)             | Angular 22 + Firebase Cloud Functions v2 + Firestore + Storage |

```
┌──────────────────────────────────────────────────────────────────┐
│                     VERTEX PLATFORM (control plane)              │
│  ┌──────────────┐  ┌──────────────────────────────────────────┐ │
│  │ Admin Angular│  │ Cloud Functions v2                        │ │
│  │ (dashboard)  │  │  provisionStore / runProvisioning         │ │
│  └──────┬───────┘  │  billing (pickBillingAccount)             │ │
│         │          │  stores / shards / seeds / versioning     │ │
│         │          └──────────────┬───────────────────────────┘ │
│  Firestore (control plane)        │ GCP API (projects, billing) │
│  stores, infrastructure_shards,   │ Firebase Management API     │
│  billing_accounts, admin_roles    │ Identity Toolkit / OAuth    │
└───────────────────────────────────┼─────────────────────────────┘
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
┌──────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│ STOREFRONT ADMIN │   │ STOREFRONT SHOP      │   │ SHARED SHARD GCP     │
│ /admin (Angular) │   │ /shop (Angular)      │   │ ecommerce-vertex-dev │
│ OAuth Google     │   │ catálogo público     │   │ hosting sites        │
└────────┬─────────┘   └──────────┬───────────┘   │ vtx-<slug>           │
         │                        │               └──────────────────────┘
         └──────── Flat Firestore (storeId-tagged) ────────┘
         products, categories, attributes, configuracion,
         banners, pages, orders, clients, settings, mail
```

## Modelo de Datos

- **Plano de control** (Firestore de `vertex-platform-*`): `stores`, `infrastructure_shards`, `billing_accounts` (y legacy `billingAccounts`), `provisioning_queue`, `provisioning_logs`, `users`, `admin_roles`, `auditLog`. Siempre privado (catch-all `isPlatformAdmin()`).
- **Datos de tienda** (Firestore del proyecto storefront / shared shard): **colecciones planas en la raíz** etiquetadas con `storeId` — sin namespaces `tenants/{tenantId}/...` desde V1.0.

Ver [data-model.md](data-model.md).

## Aprovisionamiento (End-to-End)

1. `provisionStore` (callable): valida `slug`/`name` únicos, selecciona shard (auto-heal `shared-dev-01`), decide runtime mode (`shared-shard` o `dedicated-project`), resuelve billing con **fallback automático** y crea el documento `stores/{storeId}` con `status: 'provisioning'`.
2. `runProvisioning` (trigger `onDocumentCreated`): ejecuta los pasos 1-10 (proyecto GCP, billing, Firebase, APIs, **WebApp con `gcpProjectId` real + retries 404**, Firestore, email, admin, deploy).
3. `completeStoreDeployment` (callable, llamado por GitHub Actions): finaliza, incrementa `currentStores` del shard y marca la tienda `active`.

Ver [provisioning.md](provisioning.md).

## Módulos Clave (`functions/src`)

| Archivo           | Responsabilidad                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `provisioning.ts` | Orquestación del aprovisionamiento, shards, webApp, OAuth/Identity Toolkit, fallback billing |
| `stores.ts`       | CRUD de tiendas, staff, dominios, runtime capacity, seed                                     |
| `billing.ts`      | Gestión de cuentas de facturación                                                            |
| `helpers.ts`      | `pickBillingAccount` (dual schema), `apiFetch`, `retry`, secrets, email                      |
| `shards.ts`       | Warm shards (`ensureWarmShardAvailable`)                                                     |
| `runtime.ts`      | Resolución de entorno, capacidad de shards, reconciliación                                   |
| `seeds.ts`        | Sembrado determinista flat (`footer_{storeId}`, `hero_{storeId}`, ...)                       |
| `index.ts`        | Re-export de todas las funciones                                                             |

## Clean Naming Architecture & Tooling
- **Estandarización de Archivos**: Componentes nombrados directamente sin sufijos `.component.*` (`login.ts`, `stores-list.ts`, `app-spinner.ts`, `platform-layout.ts`, etc.).
- **Clases Limpias**: Clases directas (`Login`, `StoresList`, `StoreCreate`, `StoreDetail`, `Team`, `Billing`, `AppSpinner`, `App`, etc.).
- **Build System**: `@angular/build:application` y `@angular/build:unit-test` con Vitest para pruebas Frontend y Backend.
- **Zero Vulnerabilities**: Todo el árbol de dependencias audita con **0 vulnerabilidades** en `npm audit` mediante `overrides` seguros.

## Seguridad

- Firestore: lectura pública solo para las 6 colecciones de catálogo; escrituras con `isStoreAdmin(storeId)`; plano de control con `isPlatformAdmin()`.
- Storage: lectura pública de imágenes; escritura solo admin con MIME `image/(jpeg|png|webp)` y ≤5MB.
- OAuth: `authorizedDomains` y `authorizedRedirectUris` sincronizados por tienda en Identity Toolkit.
- Ver [../firestore.rules](../firestore.rules) y la documentación del storefront (`storefront/docs/security.md`).
