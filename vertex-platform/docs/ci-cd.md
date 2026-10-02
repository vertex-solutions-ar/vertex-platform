# CI/CD, Calidad y Gobernanza de Git — Vertex Platform

## 1. Quality Gates Locales

### Repositorio `vertex-platform`

```bash
# Desde la raíz del monorepo
npm run lint                # ESLint del dashboard Angular
npm run typecheck           # tsc --noEmit + build de @vertex/contracts
npm --prefix vertex-platform run validate:rules   # validador de reglas Firestore
cd vertex-platform/functions && npm run build && npm test && cd ..   # tsc + vitest (43 tests)
```

### Repositorio `ecommerce-vertex`

```bash
npm run lint && npm run typecheck          # ESLint + tsc (app y spec)
npm run test:ci                            # 210 tests unitarios (ChromeHeadlessCI)
npm run build                              # build de producción
npm --prefix functions run build && npm --prefix functions test   # 7 tests
```

### Validación de Reglas en CI (modo standalone)

`vertex-platform/scripts/validate-firestore-rules.ts`:

- En **CI** (`CI=true` o `GITHUB_ACTIONS=true`) o forzado (`FORCE_STANDALONE=true`): valida **únicamente** el `firestore.rules` local del repositorio y sale con `process.exit(0)` — no depende de la existencia del repositorio `storefront` (runner aislado).
- En **local** (storefront presente): ejecuta la validación cruzada (full sync) de las 6 colecciones públicas de catálogo.

## 2. Hooks de Git (husky)

### `pre-commit`

- Verificación de formato (Prettier) y lint en los archivos preparados.

### `pre-push`

- **Protección de ramas**: push directo a `develop`/`main` bloqueado salvo `ALLOW_DIRECT_PUSH=true` (para automatización/agentes).
- **Quality gates completos**: Prettier check → ESLint → typecheck → tests → cobertura ≥85% (storefront).
- **Vertex-platform**: además ejecuta `validate-firestore-rules.ts`.

> En escenarios de CI/automatización se usan `HUSKY=0` (commit) y `ALLOW_DIRECT_PUSH=true` (push) de forma explícita y puntual.

## 3. GitHub Actions (CI)

| Workflow                           | Propósito                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `quality-gate`                     | Lint + typecheck + tests + build sobre `develop`/PRs; requerido para merge                |
| `deploy` (dev)                     | Despliegue automático a `vertex-platform-dev` / `ecommerce-vertex-dev`                    |
| `codeql` / `analyze-code-security` | Análisis de seguridad estático                                                            |
| `release` (storefront)             | Detecta tags `v*`, crea GitHub Release y notifica a la plataforma (`repository_dispatch`) |

### En runner aislado

El job de CI de `vertex-platform` ejecuta `npm --prefix vertex-platform run validate:rules` **sin** el checkout del repositorio `storefront`. El validador detecta la ausencia y toma el modo standalone (exit 0).

### Automatización del despliegue (GitHub OIDC)

La autenticación del workflow del storefront hacia `completeStoreDeployment` / `completeVersionUpdate` es **100% automatizada vía OIDC de GitHub Actions** (sin secrets manuales):

1. El workflow solicita `permissions: id-token: write` y obtiene un `id_token` (audience `vertex-platform`).
2. Lo envía en el body de la callable (`idToken`).
3. El platform (`functions/src/github-oidc.ts`) valida: issuer `token.actions.githubusercontent.com`, audience, `repository == vertex-solutions-ar/ecommerce-vertex` (con retrocompatibilidad para `Vertex-Tech-Devs`), `ref` y la **firma RS256 contra las JWKS de GitHub**.
4. Se conserva el fallback al deploy token legacy (Secret Manager) para compatibilidad.

> El deploy token nunca viaja en el `client_payload` del `repository_dispatch` (quedaba expuesto en logs/CI).

### Atribución Zero-Personal (Non-Human Actor / GitHub App)

Para garantizar la auditoría empresarial y prevenir que las acciones automatizadas en CI/CD queden atribuidas a un usuario personal humano (p. ej. `@juanson-espeche`):

1. **GitHub App (`vertex-deployer-bot[bot]`) o Service Token de Organización**:
   - El secreto `github-pat` en Secret Manager (`projects/{project}/secrets/github-pat`) debe contener un token de servicio bot (`vertex-deployer-bot[bot]`) o un Fine-Grained / Organization Service PAT (`ghs_*` / `ghp_*` de cuenta de servicio dedicada como `vertex-deployer-service`).
   - Esto desacopla las ejecuciones de `repository_dispatch` (`provision-store`, `update-store-version`) de cuentas de desarrolladores individuales.
2. **Setup Script Auditado**:
   - `scripts/setup-provisioning.ts` documenta y admite explícitamente tokens de bots/Service Accounts institucionales para aprovisionar el secreto.
3. **Flujo Storefront Release**:
   - `release.yml` en storefront emite `storefront-release` hacia la plataforma mediante `PLATFORM_DEPLOY_TOKEN` como actor de máquina.

## 4. Entornos y Despliegues

| Entorno | Proyecto Firebase                              | Reglas                                                                     | Functions                          |
| ------- | ---------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------- |
| Dev     | `vertex-platform-dev` / `ecommerce-vertex-dev` | `npx firebase-tools deploy --only firestore:rules,storage --project <dev>` | `--only functions --project <dev>` |
| Prod    | `vertex-platform-app` / `ecommerce-vertex`     | idem con proyecto de producción                                            | idem                               |

Notas operativas:

- El deploy de `storage` requiere que el proyecto tenga Firebase Storage habilitado y credenciales vigentes (`firebase login`).
- El deploy de `functions` del storefront requiere variables de entorno (`SITE_URL`, `MERCADOPAGO_WEBHOOK_URL`) vía dotenv/interactivo.
- `vertex-platform` puede presentar `409 unable to queue the operation` en Cloud Functions v2 cuando hay despliegues concurrentes; reintentar espaciadamente.

## 5. Gobernanza de Ramas

| Rama      | Entorno     | Regla                                                                                                            |
| --------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `develop` | Integración | Push directo permitido solo con `ALLOW_DIRECT_PUSH=true`; CI Quality Gate obligatorio                            |
| `main`    | Producción  | **Promoción exclusiva vía Pull Request** de `develop → main`; push directo bloqueado por repo rules del servidor |

### Flujo de promoción (V1.0)

1. Commit/hito en `develop` (Conventional Commits: `feat|fix|chore(release): ...`).
2. `ALLOW_DIRECT_PUSH=true git push origin develop`.
3. Crear PR `develop → main` (`gh pr create`), esperar el Quality Gate del CI y fusionar (`gh pr merge --merge --admin`).
4. **Back-merge obligatorio**: `git checkout develop && git merge origin/main && git push origin develop` → 0 divergencia.
5. Verificación final: `git rev-parse origin/develop origin/main` idénticos + `git status` limpio.

### Convención de commits

Conventional Commits: `fix(provisioning): ...`, `feat(release): ...`, `fix(ci): ...`, `fix(security): ...`, `chore(release): ...`.

## 6. Runbooks Rápidos

| Problema                     | Acción                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| CI falla por rules validator | Verificar `CI=true`/`GITHUB_ACTIONS` en el runner; el modo standalone debe salir 0 |
| Push a `main` rechazado      | Abrir PR `develop → main` y fusionar tras Quality Gate                             |
| PR bloqueada por check       | Re-ejecutar el workflow en GitHub Actions                                          |
| Divergencia develop/main     | Back-merge `main → develop`                                                        |
