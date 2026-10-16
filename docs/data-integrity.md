# Integridad de datos — controles preventivos

Este documento describe los controles que evitan que vuelvan a ocurrir las clases de
problema que ya se detectaron en producción (datos huérfanos y desfasajes). Está escrito
como runbook: qué control existe, qué previene y cómo se opera.

## 1. Problema que motivó estos controles

| Síntoma observado                                       | Causa raíz                                                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 680 documentos de tiendas borradas quedaron en 8 shards | `deleteStore` encolaba la tarea de limpieza con el **ID del documento** de `stores` (UUID), pero el purgado busca por el campo `storeId`, que guarda el **slug** del tenant → la query nunca encontraba nada. |
| Órdenes y productos sueltos invisibles en el panel      | Documentos sin campo `storeId`: las consultas filtran por ese campo.                                                                                                                                          |
| Imágenes rotas (404) en el storefront                   | Referencias a assets que ya no existen (Unsplash borrado, upload fallido).                                                                                                                                    |
| Archivos de Storage huérfanos                           | El purgado no tocaba el bucket `stores/<tenant>/`.                                                                                                                                                            |
| Tiendas sirviendo datos equivocados                     | Bundle desplegado con `tenantId: 'store'` (placeholder): el storefront resolvía el tenant por hostname en lugar de por configuración.                                                                         |
| Shards `FULL` sin ser asignables                        | Registros con `environment: 'prod'`, fuera del enum válido.                                                                                                                                                   |

## 2. Controles activos

### 2.1 Purga en cascada al borrar una tienda (origen del dato huérfano)

- `deleteStore` persiste `tenantSlug` (= `store.slug || storeId`) en
  `runtimeCleanupTasks/{taskId}`.
- `processRuntimeCleanupTask` usa ese slug (no el UUID) para purgar el shard:
  - **por campo `storeId`** (colecciones + subcolecciones vía `collectionGroup`);
  - **por convención de ID** (`belongsToTenant`): singletons `store_<t>`, `home_<t>`,
    `footer_<t>`, `aboutUs_<t>`, `emailTemplates_<t>`, `emailEngine_<t>` e IDs compuestos
    `<t>-prod-1`, `<t>-cat-x`, `<t>_<email>` — documentos que **no** llevan `storeId` y
    antes sobrevivían siempre;
  - **Storage**: borra `stores/<tenant>/` completo.
- El log deja el conteo por colección y un **warning si la purga no borró nada**, para
  detectar en el momento que el slug quedó mal resuelto.

`belongsToTenant` compara por prefijo exacto o singleton exacto (nunca por sufijo) para no
borrar documentos de otro tenant que comparta terminación.

### 2.2 Auditoría diaria de integridad (`auditDataIntegrityDaily`)

Corre todos los días a las 04:20 (America/Argentina/Buenos_Aires) y audita cada shard
productivo:

- documentos **huérfanos** (tenant que ya no existe) → alerta `critical`;
- documentos **sin `storeId`** en colecciones consultadas por ese campo → `warning`;
- **referencias colgadas** producto → categoría inexistente → `critical`;
- **singletons obligatorios faltantes** (`store_*`, `home_*`, `footer_*`) → `warning`;
- **`environment` de shard inválido** (fuera de `development | production | local`) → `critical`;
- **assets/imágenes que no responden** (hasta 40 URLs por corrida) → `warning`.

Salidas:

- `ops/dataIntegrityRuns/runs/{yyyy-mm-dd}`: historial auditable con conteos y detalle
  (retención 30 días);
- `alerts/{key}` con `kind` de integridad: los consume el **Centro de Alertas**;
- **auto-resolución**: las alertas de integridad que ya no aplican pasan a
  `status: 'resolved'` con `resolvedAt`. Sin esto el Centro de Alertas acumulaba hallazgos
  abiertos eternamente aunque el problema se hubiera arreglado.

Los detectores son funciones puras (`data-integrity.ts`) con tests propios, para que la
lógica de detección no dependa de Firestore ni de la red.

### 2.3 Guardas de despliegue (wiring del tenant)

En el repo del storefront, workflow `Deploy`:

1. **Build-time** (`scripts/generate-build-info.js`): si el pipeline declara
   `DEPLOY_TENANT_ID` y el environment compilado resuelve otro tenant (o el placeholder
   `store`), el **build aborta**. Stampó además `tenantId` en `version.json`/`build-info.ts`
   para poder auditarlo desde el artefacto.
2. **Pre-deploy**: se verifica el `tenantId` estampado en
   `dist/.../assets/version.json` contra `client_payload.tenant_id`. Si no coincide, se
   aborta **antes de publicar**.
3. **Post-deploy**: se lee `https://<site>.web.app/assets/version.json` (con reintentos por
   propagación de CDN) y se compara el `tenantId` servido contra el esperado.

## 3. Operación

```bash
# Ver la última corrida de integridad
gcloud firestore documents describe \
  --project vertex-platform-app \
  'ops/dataIntegrityRuns/runs/'"$(date -u +%F)" 2>/dev/null || \
  curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    "https://firestore.googleapis.com/v1/projects/vertex-platform-app/databases/(default)/documents/ops/dataIntegrityRuns/runs/$(date -u +%F)"

# Alertas de integridad abiertas
curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://firestore.googleapis.com/v1/projects/vertex-platform-app/databases/(default)/documents/alerts?pageSize=100" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(x['name'].split('/')[-1]) for x in d.get('documents',[]) if x['name'].split('/')[-1].startswith('data-integrity:')]"
```

## 4. Al agregar una colección nueva

1. Sumarla a `TENANT_SCOPED_COLLECTIONS` en `data-integrity.ts` (si guarda datos de tienda).
2. Si el frontend la consulta filtrando por `storeId`, sumarla también a
   `STORE_ID_QUERIED_COLLECTIONS` y **asegurarse de escribir ese campo al crear el doc**.
3. Si es un singleton `<base>_<tenantId>`, sumar `base` a `SINGLETON_BASES`.
4. Correr `npm --prefix vertex-platform/functions run test`.

## 5. Pendientes conocidos (deuda declarada)

- `billing_accounts` vs el legacy `billingAccounts`: consolidado en datos; conviene
  limpiar los fallbacks del código (`helpers.ts`, `billing-accounts.ts`).
- Cuatro colecciones de auditoría (`auditLog`, `audit_logs`, `admin_audit`,
  `system_audit`): conviene unificarlas y dar de baja las que no se leen.
- Proyectos GCP huérfanos (`kasakalle-prod`, `varela-servis`, `vtx-probando-wrr5`) y
  proyectos `vtx-sd-*` sin registro de shard: requieren decisión humana (borrado
  irreversible).
