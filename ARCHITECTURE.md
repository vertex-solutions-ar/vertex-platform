# Vertex Solutions — Technical Architecture & Operations Manual

## Repositories

| Repo | URL | Purpose |
|------|-----|---------|
| **vertex-platform** | `github.com/vertex-solutions-ar/vertex-platform` | SaaS control plane — store orchestration, provisioning, billing, platform admin |
| **ecommerce-vertex** | `github.com/vertex-solutions-ar/ecommerce-vertex` | White-label ecommerce template — deployed per tenant with custom branding |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                  vertex-platform (Control Plane)              │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────────────┐  │
│  │ Angular 22 │  │ Cloud        │  │ Firestore Rules     │  │
│  │ Admin UI   │  │ Functions v2 │  │ + Admin SDK         │  │
│  └────────────┘  └──────┬───────┘  └─────────────────────┘  │
│                          │                                    │
│                    ┌─────┴──────┐                             │
│                    │ Provisioning│ ← Secret Manager, GCP API  │
│                    │ Engine      │    GitHub Dispatch, Email  │
│                    └─────┬──────┘                             │
└──────────────────────────┼──────────────────────────────────┘
                           │
              GitHub Dispatch (repository_dispatch)
                           │
┌──────────────────────────┼──────────────────────────────────┐
│                  ecommerce-vertex (Store Template)            │
│  ┌────────────┐  ┌──────┴───────┐  ┌─────────────────────┐  │
│  │ Angular 22 │  │ Firebase     │  │ Firestore Rules     │  │
│  │ Storefront │  │ Functions v2 │  │ + Client SDK        │  │
│  └────────────┘  └──────────────┘  └─────────────────────┘  │
│                                                              │
│  Features: Catalog, Cart, Checkout (Mercado Pago),           │
│  Admin: Products, Orders, Clients, Staff, SEO, Email         │
└──────────────────────────────────────────────────────────────┘
```

### Multi-Tenant Data Model

```
/tenants/{tenantId}/
├── configuracion/store      # Store branding, colors, payments, SEO
├── products/{productId}
│   └── variants/{variantId}
├── categories/{categoryId}
├── attributes/{attributeId}
├── orders/{orderId}
├── clients/{clientId}
├── users/{userId}
├── reviews/{reviewId}
├── siteContent/{docId}
├── footerContent/{docId}
├── aboutUs/{docId}
├── pages/{docId}
├── settings/{docId}
├── mail/{docId}
└── admin_roles/{tenantId}_{email}
```

### Tenant ID Resolution

Priority order (see `storefront/src/app/core/utils/tenant.ts`):
1. `environment.tenantId` (baked at build-time)
2. Hostname parsing: `{slug}-vtx` or `vtx-{slug}` patterns
3. Query parameter `?tenantId=` (non-production only)
4. Environment fallback

---

## Provisioning Flow

### Trigger
Platform admin clicks "Create Store" → `provisionStore` HTTPS callable.

### Step-by-step Pipeline (10 steps)

| # | Step | What Happens | Shared-Shard Skip? |
|---|------|-------------|-------------------|
| 1 | `createProject` | Creates GCP project via Cloud Resource Manager API v3 | ✅ (existing project) |
| 2 | `linkBilling` | Links billing account via Cloud Billing API | ✅ |
| 3 | `addFirebase` | Adds Firebase to GCP project | ✅ |
| 4 | `enableApis` | Enables 7 GCP services (Firestore, Auth, Storage, etc.) | ✅ |
| 5 | `createWebApp` | Firebase Web App + custom Hosting site | No (always runs) |
| 6 | `initFirestore` | Creates Firestore DB, writes initial config, seeds mocks | No |
| 7 | `installEmailExtension` | Installs `firebase/firestore-send-email` extension | ✅ |
| 8 | `initAdmin` | Enables Google OAuth, writes admin_roles, sends welcome email | No |
| 9 | `grantAccess` | Adds Admin SDK service accounts as GCP project owners | No |
| 10 | `triggerDeploy` | GitHub Actions dispatch → `ecommerce-vertex` deploy | No |

### Error Handling
- **Per-step granularity:** Each step catches errors and sets `status: 'error'`
- **User-friendly errors:** GCP quota/permission errors mapped to Spanish messages
- **Retry:** Admin calls `retryProvisioning` → resets error steps to `pending`
- **Emulator mode:** Auto-completes steps without real GCP calls

### Post-Provisioning
- `completeStoreDeployment` — GitHub Action calls back to set `status: 'active'`
- Manual management via Platform admin UI: redeploy, seed data, delete, suspend

---

## Security Architecture

### Firestore Rules — Access Matrix

| Collection | Anonymous | Tenant Admin | Platform Admin |
|-----------|-----------|-------------|---------------|
| `products`, `categories`, `attributes` | ✅ Read | ✅ Write | ✅ Write |
| `siteContent`, `footerContent`, `aboutUs`, `pages` | ✅ Read | ✅ Write | ✅ Write |
| `configuracion/{docId}` | ✅ Read | ✅ Write | ✅ Write |
| **`orders/{orderId}`** | **✅ Create, Get** | ✅ List, Update, Delete | ✅ List, Update, Delete |
| `users/{userId}` | Create (own) | Read, Update, Delete | — |
| `reviews/{reviewId}` | Read | Create (auth) | Update, Delete |
| `clients/{clientId}` | — | ✅ Read | — |
| `admin_roles/{compositeId}` | — | Read (own tenant) | — |
| **`settings/{docId}`** | — | ✅ Read, Write | — |
| `mail/{docId}` | — | ✅ Read, Write | — |
| Default (fallback) | ❌ Deny | ❌ Deny | ❌ Deny |

### RBAC — Custom Claims

| Claim | Set By | Purpose |
|-------|--------|---------|
| `platformAdmin: true` + `tenantId: "{tid}"` | Cloud Functions | Platform-level access to admin UI |
| `superAdmin: true` | Environment variable `PROTECTED_SUPER_ADMINS` | Factory-hardcoded super-admin access |
| `admin: true` + `tenantId: "{tid}"` | Cloud Functions (on provisioning) | Store-level admin access |
| `owner: true` + `tenantId: "{tid}"` | Cloud Functions (provisioning or staff) | Store-level owner access |
| `store: "{slug}"` | Cloud Functions | Storefront admin UI routing |

### Super-Admin Protection
- Configurable via `PROTECTED_SUPER_ADMINS` environment variable (comma-separated emails)
- Hardcoded fallback: `juan.l.espeche@gmail.com,leivalihue@gmail.com,vertex.tech.dev@gmail.com`
- Re-ensured on every `listAdmins` call and `onPlatformAdminRoleChange` trigger
- Cannot be demoted below `superAdmin` role

### Secret Management

| Secret | Stored In | Used By | Purpose |
|--------|-----------|---------|---------|
| GCP OAuth credentials | Secret Manager | Provisioning engine | Create/manage GCP projects |
| GitHub PAT | Secret Manager | Provisioning engine | Dispatch deploy events |
| Deploy token | Secret Manager | Both repos | Auth `completeStoreDeployment` callback |
| SMTP password | Secret Manager | Email extension | Send transactional emails |
| Mercado Pago access token | Secret Manager (per-store) | Store functions | Payment processing |

**Principle:** Sensitive tokens never written to Firestore. Raw access tokens are replaced with Secret Manager references + masked values before Firestore persistence.

---

## Deployment Architecture

### Development
```
Platform:  https://vertex-platform-dev.web.app
Store:     https://vtx-{slug}-dev.web.app
Emulator:  http://localhost:4200 (platform), http://localhost:4201 (store)
Functions: Firebase Emulator Suite (localhost:5001)
```

### Production
```
Platform:  https://admin.vertex.com.ar
Store:     https://{slug}.vertex.com.ar (or custom domains)
Functions: Cloud Functions (us-central1)
```

### CI/CD Pipeline
```
Push → GitHub Actions:
  1. Standards Baseline Check (governance files)
  2. Lint & Type Check (eslint + tsc --noEmit)
  3. Unit Tests (ng test / vitest)
  4. Build (Frontend + Functions)
  5. E2E Tests (Cypress)
  6. Integration Tests (Playwright)
  7. Security Audit (CodeQL)
  8. Quality Gate (aggregate status)
```

### Quality Gates (Pre-push Hook)
```
1. Prettier formatting check
2. ESLint linting
3. TypeScript type check (tsc --noEmit)
4. Frontend unit tests (ng test)
5. Functions unit tests (vitest run)
6. Coverage verification (>=85% all metrics)
7. Firestore rules validation
```

---

## Dependency Management

### Current Versions (Stable LTS)

| Dependency | Version | Notes |
|-----------|---------|-------|
| Node.js | 24 LTS | Set in `.nvmrc` and `engines` |
| TypeScript | ^6.0.3 | Unified across all workspaces |
| Angular | ^22.0.x | Consistent across platform + storefront |
| Firebase Functions | v6–v7 | Platform on v6, storefront on v7 |
| Firebase Admin | v13–v14 | Platform functions on v13, storefront on v14 |
| Zod | v4.4.3 | Unified in `@vertex/contracts` |
| ESLint | v9–v10 | Platform on v9, storefront on v10 (flat config) |
| Vitest | v4.1.9 | Consistent across all workspaces |
| RxJS | v7.8.x | Consistent |

### Security Overrides
All transitive dependency CVEs are addressed via `overrides` in each `package.json`. Regular `npm audit` runs show zero vulnerabilities. See individual `package.json` files for the current override list.

---

## Key Files Reference

### Platform (`vertex-platform`)

| File | Purpose |
|------|---------|
| `src/app/core/services/auth.ts` | Auth service with platformAdmin claim management |
| `src/app/core/services/stores.ts` | Store CRUD calling Cloud Functions |
| `src/app/features/stores/components/store-create/store-create.ts` | Store creation form |
| `src/app/features/stores/components/store-detail/store-detail.ts` | Store detail with provisioning, config, team, domains |
| `src/app/core/utils/error.util.ts` | Type-safe error message extraction |
| `functions/src/provisioning.ts` | 10-step provisioning pipeline (1619 lines) |
| `functions/src/stores.ts` | Store management Cloud Functions |
| `functions/src/admin.ts` | Admin CRUD, RBAC, protected super-admins |
| `functions/src/runtime.ts` | Shard capacity, `reconcileActiveStores` scheduler |
| `functions/src/helpers.ts` | Shared utilities, credentials, secrets, email |
| `functions/src/seeds.ts` | Seed engine for demo data (3 verticals) |

### Storefront (`ecommerce-vertex`)

| File | Purpose |
|------|---------|
| `src/app/core/services/store-config.service.ts` | Store config loading + reactive DOM effects |
| `src/app/core/services/cart.service.ts` | Signal-based cart with localStorage persistence |
| `src/app/core/services/auth.service.ts` | Firebase Auth + admin claim verification |
| `src/app/core/services/product.service.ts` | Product CRUD + queries |
| `src/app/core/services/order.service.ts` | Order CRUD + metrics |
| `src/app/core/services/storage.service.ts` | Firebase Storage upload with progress |
| `src/app/features/shop/components/checkout/checkout.component.ts` | Mercado Pago checkout flow |
| `src/app/features/shop/components/catalog/catalog.component.ts` | Filtered, paginated product catalog |
| `src/app/features/admin/components/products/product-create/product-create.component.ts` | Product + variants creation/editing |
| `src/app/core/utils/tenant.ts` | Tenant ID resolution |
| `src/app/core/utils/error.util.ts` | Type-safe error message extraction |

---

## Environment Configuration

### Platform

| Variable | Required | Description |
|----------|----------|-------------|
| `PROTECTED_SUPER_ADMINS` | No | Comma-separated super-admin emails (fallback: hardcoded list) |
| `FUNCTIONS_EMULATOR` | No | Set to `true` for local emulation |
| `GCLOUD_PROJECT` | Yes | Firebase project ID |

### Storefront

| Variable | Required | Description |
|----------|----------|-------------|
| `tenantId` | Yes (in `environment.ts`) | Default tenant for local dev |
| `production` | Yes | `true`/`false` for emulator vs production |
| `firebaseConfig` | Yes | Firebase project configuration |

---

## Known Limitations & Future Work

| Area | Issue | Priority |
|------|-------|----------|
| Shard capacity | Race condition on slot allocation (no atomic claim) | Medium |
| Slug uniqueness | Non-transactional check allows duplicates under concurrent requests | Medium |
| Secret rotation | In-memory cache prevents picking up rotated secrets during function lifetime | Low |
| GitHub deploy | `completeStoreDeployment` callback not testable in emulator | Low |
| Pagination | `reconcileActiveStores` query lacks pagination (beyond 1000 stores) | Low |
| ALLOWED_ORIGINS | Hardcoded — requires redeploy to add origins | Low |
| Test coverage | 30+ untested components in storefront, 6+ untested Cloud Functions | Medium |
