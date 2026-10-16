import type { Firestore } from 'firebase-admin/firestore';

/**
 * Sistema de integridad de datos (prevención de datos huérfanos y desfasajes).
 *
 * Motiva incidentes reales ya observados en producción:
 *  - Documentos de tiendas borradas que quedaron en el shard (680 docs).
 *  - Documentos sin `storeId`, invisibles para las consultas filtradas por tienda.
 *  - Valores de enum inválidos (`environment: 'prod'`) que dejaban registros fuera de
 *    toda consulta de asignación.
 *  - Referencias colgadas (producto → categoría inexistente) e imágenes rotas.
 *
 * Los detectores son funciones puras sobre un snapshot para poder testearlos sin red ni
 * Firestore; el runner sólo se encarga de leer y de emitir las alertas.
 */

/** Colecciones donde una tienda guarda datos dentro de su shard. */
export const TENANT_SCOPED_COLLECTIONS = [
  'products',
  'categories',
  'attributes',
  'banners',
  'pages',
  'configuracion',
  'settings',
  'admin_roles',
  'clients',
  'orders',
  'mail',
  'store_payments',
  'system_health',
  'reviews',
] as const;

/**
 * Colecciones que el storefront/admin consultan filtrando por `storeId`: un documento
 * sin ese campo es invisible aunque exista (bug real: órdenes y productos sueltos).
 */
export const STORE_ID_QUERIED_COLLECTIONS = [
  'products',
  'categories',
  'attributes',
  'clients',
  'orders',
] as const;

/** Singletons del storefront guardados como `<base>_<tenantId>`. */
export const SINGLETON_BASES = [
  'store',
  'home',
  'footer',
  'aboutUs',
  'emailTemplates',
  'emailEngine',
] as const;

/**
 * ¿El ID de un documento pertenece al tenant?
 * Cubre los IDs compuestos del store (`<t>-prod-1`, `<t>-cat-x`, `<t>_<email>`) y los
 * singletons del storefront (`store_<t>`, `home_<t>`, ...), que NO llevan campo
 * `storeId` y por eso sobrevivían al purgado por query. La comparación es por prefijo
 * exacto o singleton exacto — nunca por sufijo — para no borrar datos de otro tenant.
 */
export function belongsToTenant(docId: string, tenant: string): boolean {
  if (!docId || !tenant) return false;
  const id = docId.toLowerCase();
  const t = tenant.toLowerCase();
  if (id === t) return true;
  if (id.startsWith(`${t}_`) || id.startsWith(`${t}-`)) return true;
  return SINGLETON_BASES.some((base) => id === `${base.toLowerCase()}_${t}`);
}

/** Valores válidos de `environment` (deben coincidir con PlatformEnvironment). */
export const VALID_ENVIRONMENTS = ['development', 'production', 'local'] as const;

export type IntegrityKind =
  | 'orphan_docs'
  | 'missing_store_id'
  | 'dangling_ref'
  | 'invalid_enum'
  | 'missing_singleton'
  | 'unreachable_asset';

export interface IntegrityFinding {
  /** Clave estable y deduplicable para el Centro de Alertas. */
  key: string;
  severity: 'warning' | 'critical';
  kind: IntegrityKind;
  tenant: string;
  projectId: string;
  title: string;
  message: string;
}

export interface TenantDoc {
  id: string;
  storeId?: string | null;
  data?: Record<string, unknown>;
}

/** Snapshot de un proyecto (shard) listo para auditar. */
export interface ShardSnapshot {
  projectId: string;
  tenants: Set<string>;
  collections: Record<string, TenantDoc[]>;
}

/** Determina a qué tenant pertenece un documento, por `storeId` o por convención de ID. */
export function tenantOfDoc(
  docId: string,
  storeId: string | null | undefined,
  shardTenantHint: string,
): string {
  if (storeId) return storeId;
  for (const base of SINGLETON_BASES) {
    const prefix = `${base}_`;
    if (docId.toLowerCase().startsWith(prefix.toLowerCase())) {
      return docId.slice(prefix.length);
    }
  }
  for (const suffix of ['-prod-', '-cat-', '-attr-', '-ORD-']) {
    if (docId.includes(suffix)) return docId.split(suffix)[0];
  }
  if (docId.includes('_') && docId.includes('@')) return docId.split('_')[0];
  return shardTenantHint;
}

/** Documentos cuyo tenant no existe: dato huérfano de una tienda borrada. */
export function findOrphanDocs(
  snapshot: ShardSnapshot,
  shardTenantHint: string,
): IntegrityFinding[] {
  const byTenant = new Map<string, string[]>();
  for (const [collection, docs] of Object.entries(snapshot.collections)) {
    for (const doc of docs) {
      const tenant = tenantOfDoc(doc.id, doc.storeId, shardTenantHint);
      if (!tenant || snapshot.tenants.has(tenant)) continue;
      const key = `${collection}/${doc.id}`;
      const list = byTenant.get(tenant) ?? [];
      list.push(key);
      byTenant.set(tenant, list);
    }
  }
  return [...byTenant.entries()].map(([tenant, docs]) => ({
    key: `data-integrity:orphan-docs:${snapshot.projectId}:${tenant}`,
    severity: 'critical' as const,
    kind: 'orphan_docs' as const,
    tenant,
    projectId: snapshot.projectId,
    title: `Datos huérfanos de la tienda «${tenant}»`,
    message:
      `Hay ${docs.length} documento(s) de un tenant que ya no existe (ej.: ` +
      `${docs.slice(0, 3).join(', ')}). Ejecutá el purgado del tenant en el shard ` +
      `${snapshot.projectId}.`,
  }));
}

/** Documentos sin `storeId` en colecciones que se consultan por ese campo. */
export function findMissingStoreId(
  snapshot: ShardSnapshot,
  shardTenantHint: string,
): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  for (const collection of STORE_ID_QUERIED_COLLECTIONS) {
    const docs = snapshot.collections[collection] ?? [];
    const missing = docs
      .filter((doc) => !doc.storeId)
      .map((doc) => doc.id)
      .filter((id) => snapshot.tenants.has(tenantOfDoc(id, null, shardTenantHint)));
    if (missing.length === 0) continue;
    const tenant = tenantOfDoc(missing[0], null, shardTenantHint);
    findings.push({
      key: `data-integrity:missing-store-id:${snapshot.projectId}:${collection}:${tenant}`,
      severity: 'warning',
      kind: 'missing_store_id',
      tenant,
      projectId: snapshot.projectId,
      title: `Documentos sin storeId en ${collection}`,
      message:
        `${missing.length} documento(s) en ${collection} no declaran storeId, por lo que ` +
        `quedan fuera de las consultas del panel (ej.: ${missing.slice(0, 3).join(', ')}).`,
    });
  }
  return findings;
}

/** Productos que apuntan a una categoría inexistente (referencia colgada). */
export function findDanglingCategoryRefs(
  snapshot: ShardSnapshot,
  shardTenantHint: string,
): IntegrityFinding[] {
  const categoryIds = new Set((snapshot.collections['categories'] ?? []).map((doc) => doc.id));
  const byTenant = new Map<string, string[]>();
  for (const doc of snapshot.collections['products'] ?? []) {
    const categoryId = doc.data?.['categoryId'];
    if (typeof categoryId !== 'string' || categoryId.length === 0) continue;
    if (categoryIds.has(categoryId)) continue;
    const tenant = tenantOfDoc(doc.id, doc.storeId, shardTenantHint);
    const list = byTenant.get(tenant) ?? [];
    list.push(`${doc.id} → ${categoryId}`);
    byTenant.set(tenant, list);
  }
  return [...byTenant.entries()].map(([tenant, refs]) => ({
    key: `data-integrity:dangling-category:${snapshot.projectId}:${tenant}`,
    severity: 'critical' as const,
    kind: 'dangling_ref' as const,
    tenant,
    projectId: snapshot.projectId,
    title: `Productos con categoría inexistente (${tenant})`,
    message: `${refs.length} producto(s) apuntan a categorías que no existen: ${refs.slice(0, 3).join(', ')}.`,
  }));
}

/** Singletons obligatorios que faltan para un tenant (configuración incompleta). */
export function findMissingSingletons(
  snapshot: ShardSnapshot,
  shardTenantHint: string,
): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  for (const tenant of snapshot.tenants) {
    if (
      shardTenantHint !== tenant &&
      !(snapshot.collections['configuracion'] ?? []).some(
        (d) => tenantOfDoc(d.id, d.storeId, shardTenantHint) === tenant,
      )
    ) {
      continue; // el tenant no vive en este proyecto
    }
    const missing = SINGLETON_BASES.filter(
      (base) =>
        !(snapshot.collections['configuracion'] ?? []).some((d) => d.id === `${base}_${tenant}`) &&
        !(snapshot.collections['banners'] ?? []).some((d) => d.id === `${base}_${tenant}`) &&
        !(snapshot.collections['pages'] ?? []).some((d) => d.id === `${base}_${tenant}`) &&
        !(snapshot.collections['settings'] ?? []).some((d) => d.id === `${base}_${tenant}`),
    );
    const core = missing.filter((base) => base === 'store' || base === 'home' || base === 'footer');
    if (core.length === 0) continue;
    findings.push({
      key: `data-integrity:missing-singleton:${snapshot.projectId}:${tenant}`,
      severity: 'warning',
      kind: 'missing_singleton',
      tenant,
      projectId: snapshot.projectId,
      title: `Configuración incompleta de «${tenant}»`,
      message: `Faltan singletons obligatorios: ${core.join(', ')}.`,
    });
  }
  return findings;
}

/** Registros de shard con `environment` fuera del enum válido (quedan fuera de las queries). */
export function findInvalidShardEnvironments(
  shards: Array<{ id: string; environment?: string | null }>,
): IntegrityFinding[] {
  const invalid = shards.filter(
    (s) =>
      !s.environment ||
      !VALID_ENVIRONMENTS.includes(s.environment as (typeof VALID_ENVIRONMENTS)[number]),
  );
  if (invalid.length === 0) return [];
  return [
    {
      key: 'data-integrity:invalid-shard-environment',
      severity: 'critical',
      kind: 'invalid_enum',
      tenant: '-',
      projectId: '-',
      title: 'Shards con environment inválido',
      message:
        `${invalid.length} registro(s) de infrastructure_shards tienen un environment que no ` +
        `coincide con ${VALID_ENVIRONMENTS.join(' | ')} (ej.: ` +
        `${invalid
          .slice(0, 3)
          .map((s) => `${s.id}=${s.environment}`)
          .join(', ')}). ` +
        'No son asignables por el provisioner.',
    },
  ];
}

/**
 * Verifica que las URLs de assets respondan (imágenes rotas que rompen el storefront).
 * Concurrencia acotada y límite de URLs para mantener el costo predecible.
 */
export async function findUnreachableAssets(
  urls: string[],
  options: { limit?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<IntegrityFinding[]> {
  const fetcher = options.fetchImpl ?? fetch;
  const limit = options.limit ?? 40;
  const timeoutMs = options.timeoutMs ?? 8000;
  const unique = [...new Set(urls)].slice(0, limit);
  const broken: string[] = [];
  const check = async (url: string): Promise<void> => {
    try {
      const res = await fetcher(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) broken.push(`${url} (${res.status})`);
    } catch {
      broken.push(`${url} (inaccesible)`);
    }
  };
  // Ventana de concurrencia sin dependencias externas.
  for (let i = 0; i < unique.length; i += 8) {
    await Promise.all(unique.slice(i, i + 8).map(check));
  }
  if (broken.length === 0) return [];
  return [
    {
      key: 'data-integrity:unreachable-assets',
      severity: 'warning',
      kind: 'unreachable_asset',
      tenant: '-',
      projectId: '-',
      title: 'Assets e imágenes rotas',
      message:
        `${broken.length} asset(s) no responden (ej.: ${broken.slice(0, 3).join(', ')}). ` +
        'Se mostrarán imágenes quebradas en el storefront.',
    },
  ];
}

/** Ejecuta todos los detectores sobre un snapshot (sin red). */
export function auditShardSnapshot(
  snapshot: ShardSnapshot,
  shardTenantHint: string,
): IntegrityFinding[] {
  return [
    ...findOrphanDocs(snapshot, shardTenantHint),
    ...findMissingStoreId(snapshot, shardTenantHint),
    ...findDanglingCategoryRefs(snapshot, shardTenantHint),
    ...findMissingSingletons(snapshot, shardTenantHint),
  ];
}

/** Claves de alertas que ya no corresponden a ningún hallazgo: se auto-resuelven. */
export function staleAlertKeys(openKeys: string[], currentKeys: string[]): string[] {
  const current = new Set(currentKeys);
  return openKeys.filter((key) => !current.has(key));
}

/** Lee las colecciones de un shard y devuelve el snapshot para auditar. */
export async function readShardSnapshot(
  projectId: string,
  tenants: Set<string>,
  shardTenantHint: string,
  shardDb: Firestore,
): Promise<ShardSnapshot> {
  const db = shardDb;
  const collections: Record<string, TenantDoc[]> = {};
  await Promise.all(
    TENANT_SCOPED_COLLECTIONS.map(async (collection) => {
      try {
        const snap = await db.collection(collection).limit(1000).get();
        collections[collection] = snap.docs.map((doc) => ({
          id: doc.id,
          storeId: (doc.data() as { storeId?: string | null }).storeId ?? null,
          data: doc.data() as Record<string, unknown>,
        }));
      } catch {
        collections[collection] = [];
      }
    }),
  );
  return { projectId, tenants, collections };
}

/** Recolecta URLs de assets referenciadas por el snapshot. */
export function collectAssetUrls(snapshot: ShardSnapshot): string[] {
  const urls = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (/^https?:\/\//.test(value) && /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(value)) {
        urls.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(walk);
    }
  };
  for (const docs of Object.values(snapshot.collections)) {
    for (const doc of docs) walk(doc.data);
  }
  return [...urls];
}

/** Clave de alerta por defecto para un hallazgo del sistema de integridad. */
export function integrityAlertKey(finding: IntegrityFinding): string {
  return finding.key.startsWith('data-integrity:') ? finding.key : `data-integrity:${finding.key}`;
}
