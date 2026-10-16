import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as logger from 'firebase-functions/logger';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  auditShardSnapshot,
  collectAssetUrls,
  findInvalidShardEnvironments,
  findUnreachableAssets,
  integrityAlertKey,
  readShardSnapshot,
  staleAlertKeys,
  type IntegrityFinding,
} from './data-integrity';
import { getFirestoreForProject } from './stores';

/** Alertas que este auditor posee: sólo estas se auto-resuelven. */
const ALERT_KEY_PREFIX = 'data-integrity:';
/** Cuántas corridas diarias se conservan en `ops/dataIntegrityRuns`. */
const RUNS_RETENTION_DAYS = 30;

interface StoreDoc {
  id: string;
  slug?: string;
  status?: string;
  firebaseProjectId?: string;
  runtimeProjectId?: string;
  shardId?: string;
}

/**
 * auditDataIntegrityDaily — Red de seguridad de DATOS (una corrida por día).
 *
 * Audita cada shard productivo en busca de las clases de problema que ya nos
 * afectaron en producción y que, sin control, vuelven a aparecer en silencio:
 *  - documentos huérfanos de tiendas borradas,
 *  - documentos sin `storeId` (invisibles para el panel),
 *  - referencias colgadas (producto → categoría inexistente),
 *  - configuración incompleta (singletons faltantes),
 *  - shards con `environment` fuera del enum,
 *  - assets/imágenes que no responden.
 *
 * Publica:
 *  - `ops/dataIntegrityRuns/{yyyy-mm-dd}` con el detalle de la corrida,
 *  - `alerts/{key}` deduplicadas (las consume el Centro de Alertas),
 *  - y AUTO-RESUELVE las alertas de integridad que ya no aplican (así el Centro de
 *    Alertas no queda con hallazgos eternamente abiertos).
 */
export const auditDataIntegrityDaily = onSchedule(
  {
    schedule: 'every day 04:20',
    timeZone: 'America/Argentina/Buenos_Aires',
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async () => {
    const startedAt = Date.now();
    const db = getFirestore();
    const findings: IntegrityFinding[] = [];

    // 1) Tiendas vivas agrupadas por proyecto de runtime (los shards son multi-tenant).
    const storesSnap = await db
      .collection('stores')
      .where('status', 'in', ['active', 'provisioning', 'suspended'])
      .get();
    const stores: StoreDoc[] = storesSnap.docs.map((doc) => ({
      id: doc.id,
      ...(doc.data() as Omit<StoreDoc, 'id'>),
    }));

    const byProject = new Map<string, Set<string>>();
    for (const store of stores) {
      const tenant = (store.slug || store.id || '').trim();
      const projectId = (store.runtimeProjectId || store.firebaseProjectId || '').trim();
      if (!tenant || !projectId) continue;
      const tenants = byProject.get(projectId) ?? new Set<string>();
      tenants.add(tenant);
      byProject.set(projectId, tenants);
    }

    // 2) Auditoría por shard. El "hint" sólo se usa para documentos sin storeId ni
    //    prefijo reconocible: en shards multi-tenant se deja vacío para no atribuir
    //    documentos al tenant equivocado.
    const assetUrls: string[] = [];
    let auditedProjects = 0;
    for (const [projectId, tenants] of byProject) {
      try {
        const hint = tenants.size === 1 ? [...tenants][0] : '';
        const snapshot = await readShardSnapshot(
          projectId,
          tenants,
          hint,
          getFirestoreForProject(projectId),
        );
        findings.push(...auditShardSnapshot(snapshot, hint));
        assetUrls.push(...collectAssetUrls(snapshot));
        auditedProjects += 1;
      } catch (err) {
        logger.warn(`[DataIntegrity] No se pudo auditar el shard ${projectId}:`, err);
      }
    }

    // 3) Registros de shard con enum inválido (quedan fuera de las queries del pool).
    try {
      const shardsSnap = await db.collection('infrastructure_shards').get();
      findings.push(
        ...findInvalidShardEnvironments(
          shardsSnap.docs.map((doc) => ({
            id: doc.id,
            environment: (doc.data() as { environment?: string }).environment ?? null,
          })),
        ),
      );
    } catch (err) {
      logger.warn('[DataIntegrity] No se pudieron leer los shards:', err);
    }

    // 4) Assets rotos (acotado para mantener el costo predecible).
    try {
      findings.push(...(await findUnreachableAssets(assetUrls, { limit: 40 })));
    } catch (err) {
      logger.warn('[DataIntegrity] No se pudieron verificar los assets:', err);
    }

    const currentKeys = findings.map(integrityAlertKey);

    // 5) Upsert de alertas (mismo formato que consume el Centro de Alertas).
    const now = Date.now();
    let created = 0;
    let updated = 0;
    for (const finding of findings) {
      const key = integrityAlertKey(finding);
      const ref = db.collection('alerts').doc(key);
      const existing = await ref.get();
      if (!existing.exists) {
        await ref.set({
          key,
          severity: finding.severity,
          kind: finding.kind,
          storeId: finding.tenant,
          projectId: finding.projectId,
          title: finding.title,
          message: finding.message,
          status: 'open',
          firstSeen: Timestamp.fromMillis(now),
          lastSeen: Timestamp.fromMillis(now),
          count: 1,
          resolvedAt: null,
        });
        created += 1;
      } else {
        await ref.update({
          status: 'open',
          lastSeen: Timestamp.fromMillis(now),
          resolvedAt: null,
          count: FieldValue.increment(1),
          severity: finding.severity,
          message: finding.message,
        });
        updated += 1;
      }
    }

    // 6) Auto-resolución: alertas de integridad que ya no aplican.
    let resolved = 0;
    try {
      const openSnap = await db.collection('alerts').where('status', '==', 'open').get();
      const ownedOpenKeys = openSnap.docs
        .map((doc) => doc.id)
        .filter((key) => key.startsWith(ALERT_KEY_PREFIX));
      for (const key of staleAlertKeys(ownedOpenKeys, currentKeys)) {
        await db
          .collection('alerts')
          .doc(key)
          .update({
            status: 'resolved',
            resolvedAt: Timestamp.fromMillis(now),
          });
        resolved += 1;
      }
    } catch (err) {
      logger.warn('[DataIntegrity] No se pudieron resolver alertas obsoletas:', err);
    }

    // 7) Historial de la corrida (una entrada por día) + retención.
    const runId = new Date(now).toISOString().slice(0, 10);
    const runsCol = db.collection('ops').doc('dataIntegrityRuns').collection('runs');
    await runsCol.doc(runId).set({
      ranAt: new Date(now),
      durationMs: Date.now() - startedAt,
      projectsAudited: auditedProjects,
      storesAudited: stores.length,
      findingsCount: findings.length,
      alertsCreated: created,
      alertsUpdated: updated,
      alertsResolved: resolved,
      findings: findings.map((f) => ({
        key: integrityAlertKey(f),
        severity: f.severity,
        kind: f.kind,
        tenant: f.tenant,
        projectId: f.projectId,
        title: f.title,
      })),
    });
    try {
      const cutoff = new Date(now - RUNS_RETENTION_DAYS * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const old = await runsCol.where('__name__', '<', cutoff).get();
      if (!old.empty) {
        const batch = db.batch();
        old.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
      }
    } catch (err) {
      logger.warn('[DataIntegrity] Retención de corridas falló (no bloqueante):', err);
    }

    logger.info(
      `[DataIntegrity] Corrida ${runId}: ${findings.length} hallazgo(s) en ` +
        `${auditedProjects} shard(s) · ${created} nueva(s), ${updated} actualizada(s), ` +
        `${resolved} resuelta(s) · ${Date.now() - startedAt}ms`,
    );
  },
);
