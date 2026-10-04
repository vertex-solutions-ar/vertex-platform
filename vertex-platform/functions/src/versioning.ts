import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore } from 'firebase-admin/firestore';
import {
  getGitHubPat,
  ALLOWED_ORIGINS,
  PLATFORM_PROJECT,
  getDeployToken,
  calculateDeploySequence,
  recordStoreDeployHistory,
} from './helpers';
import { resolvePlatformEnvironment } from './runtime';
import { verifyGitHubOidcToken } from './github-oidc';

interface GitHubRelease {
  tag_name: string;
  name: string;
  published_at: string;
  prerelease: boolean;
  draft: boolean;
  html_url: string;
  body?: string;
}

export interface TemplateVersion {
  version: string;
  tag: string;
  publishedAt: string;
  isLatest: boolean;
  notes?: string;
  /**
   * Esquema de datos que esta versión del template produce/requiere.
   * Sube SOLO cuando cambia la estructura de datos (products/orders/clients).
   * Se usa para el gate de compatibilidad del selector.
   */
  schemaVersion: number;
}

/**
 * Mapa de versión del template → schemaVersion de datos.
 * Mantener en sync con CURRENT_STORE_SCHEMA_VERSION del provisioning:
 *  - Igual que el actual = compatible (upgrade/downgrade sin migración).
 *  - MAYOR que el actual = la versión nueva cambia el esquema (requiere migración).
 *  - MENOR que el actual = la tienda tiene datos más nuevos (downgrade incompatible).
 */
const SCHEMA_BY_VERSION: Record<string, number> = {
  '0.1.0': 1,
  '0.2.0': 1,
  '0.3.0': 1,
  '0.4.0': 1,
  '0.5.0': 1,
  '0.8.5': 1,
  '0.9.4': 1,
};

function getSchemaVersion(v?: string): number {
  if (!v) return 1;
  const clean = v.replace(/^v/, '');
  return SCHEMA_BY_VERSION[clean] ?? 1;
}

let cachedReleasesList: { timestamp: number; versions: TemplateVersion[] } | null = null;
const CACHE_TTL_MS = 60 * 1000; // 60s TTL

export function _clearTemplateVersionsCache(): void {
  cachedReleasesList = null;
}

export const listTemplateVersions = onCall<{ forceRefresh?: boolean }>(
  { cors: ALLOWED_ORIGINS, invoker: 'public' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError('permission-denied', 'Only platform admins can list template versions.');
    }

    const forceRefresh = Boolean(request.data?.forceRefresh);
    const now = Date.now();

    if (!forceRefresh && cachedReleasesList && now - cachedReleasesList.timestamp < CACHE_TTL_MS) {
      return { versions: cachedReleasesList.versions };
    }

    try {
      const pat = await getGitHubPat();

      // Releases publicadas (fuente primaria: notas + fecha real).
      let releases: GitHubRelease[] = [];
      const res = await fetch(
        'https://api.github.com/repos/vertex-solutions-ar/ecommerce-vertex/releases?per_page=20',
        {
          headers: {
            Authorization: `Bearer ${pat}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );
      if (!res.ok) {
        throw new Error(`GitHub releases API failed: ${res.status}`);
      }
      releases = (await res.json()) as GitHubRelease[];
      const published = releases.filter((r) => !r.draft && !r.prerelease);

      // Releases oficiales publicadas desde la rama main.
      // Solo se reconocen releases formales publicadas (prerelease: false y draft: false)
      // para evitar que tags o pre-releases de branches de desarrollo se usen en producción.
      const byVersion = new Map<string, TemplateVersion>();
      for (const r of published) {
        const relVersion = r.tag_name.replace(/^v/, '');
        byVersion.set(relVersion, {
          version: relVersion,
          tag: r.tag_name,
          publishedAt: r.published_at,
          isLatest: false,
          notes: r.body ?? undefined,
          schemaVersion: SCHEMA_BY_VERSION[relVersion] ?? 0,
        });
      }

      // Orden desc por semver y marca la más alta como latest.
      const versions = [...byVersion.values()].sort((a, b) =>
        compareVersions(b.version, a.version),
      );
      if (versions.length > 0) {
        versions[0] = { ...versions[0], isLatest: true };
      }

      cachedReleasesList = { timestamp: now, versions };

      return { versions };
    } catch (err) {
      console.warn('[listTemplateVersions] Failed to fetch releases:', err);
      // Si falla la llamada externa pero tenemos caché previo, devolverlo en vez de vacío
      if (cachedReleasesList) {
        return { versions: cachedReleasesList.versions };
      }
      return { versions: [] };
    }
  },
);

/** Compara versiones semver (x.y.z) numéricamente, ignorando pre-releases. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const updateStoreVersion = onCall<{ storeId: string; version: string }>(
  { cors: ALLOWED_ORIGINS, invoker: 'public' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError('permission-denied', 'Only platform admins can update store versions.');
    }

    const { storeId, version } = request.data;
    if (!storeId || !version) {
      throw new HttpsError('invalid-argument', 'storeId and version are required.');
    }

    const db = getFirestore();
    const storeRef = db.collection('stores').doc(storeId);
    const snap = await storeRef.get();

    if (!snap.exists) {
      throw new HttpsError('not-found', 'Store not found.');
    }

    const storeData = snap.data()!;
    if (storeData['status'] !== 'active') {
      throw new HttpsError('failed-precondition', 'Store must be active to update its version.');
    }

    if (storeData['versionUpdateStatus'] === 'updating') {
      const updatedAt = storeData['updatedAt']?.toDate
        ? storeData['updatedAt'].toDate().getTime()
        : storeData['updatedAt']
          ? new Date(storeData['updatedAt']).getTime()
          : 0;
      const tenMinutes = 10 * 60 * 1000;
      if (Date.now() - updatedAt < tenMinutes) {
        throw new HttpsError('failed-precondition', 'A version update is already in progress.');
      }
    }

    // ── Gate de compatibilidad por schemaVersion ─────────────────────────────
    // version.schemaVersion < store.schemaVersion → la versión es más vieja que
    // los datos → downgrade incompatible (BLOQUEADO).
    // version.schemaVersion > store.schemaVersion → la versión nueva cambia el
    // esquema → se permite pero se marca pendingMigration.
    const targetSchema = getSchemaVersion(version);
    const storeSchema = Number(storeData['schemaVersion'] ?? 0) || 0;
    if (targetSchema !== 0 && targetSchema < storeSchema) {
      throw new HttpsError(
        'failed-precondition',
        `La versión v${version} requiere un esquema de datos menor (v${targetSchema}) que el de la tienda (v${storeSchema}). Downgrade incompatible — no se puede aplicar.`,
      );
    }
    const needsMigration = targetSchema > storeSchema;

    const pat = await getGitHubPat();

    const tagRes = await fetch(
      `https://api.github.com/repos/vertex-solutions-ar/ecommerce-vertex/git/refs/tags/v${version}`,
      {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!tagRes.ok) {
      throw new HttpsError('not-found', `Version v${version} does not exist in the repository.`);
    }

    const configSnap = await db
      .collection('stores')
      .doc(storeId)
      .collection('private')
      .doc('firebaseConfig')
      .get();

    if (!configSnap.exists) {
      throw new HttpsError('failed-precondition', 'Store Firebase config not found.');
    }

    const firebaseConfig = configSnap.data() as Record<string, string>;

    const deployToken = await getDeployToken();
    const deploySequence = await calculateDeploySequence(db, storeId);

    try {
      const res = await fetch(
        'https://api.github.com/repos/vertex-solutions-ar/ecommerce-vertex/dispatches',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${pat}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            event_type: 'update-store-version',
            client_payload: {
              store_id: storeId,
              tenant_id: storeData['slug'],
              site_id: storeData['runtimeSiteId'] || 'default',
              project_id: storeData['firebaseProjectId'],
              firebase_config: JSON.stringify(firebaseConfig),
              platform_project_id: PLATFORM_PROJECT,
              deploy_token: deployToken,
              environment: resolvePlatformEnvironment(PLATFORM_PROJECT),
              ref: `refs/tags/v${version}`,
              meta: {
                version,
                deploy_number: deploySequence.deployNumber,
                redeploy_number: deploySequence.redeployNumber,
                is_redeploy: deploySequence.isRedeploy,
                deploy_timestamp: deploySequence.deployTimestamp,
              },
            },
          }),
        },
      );

      if (!res.ok && res.status !== 204) {
        const body = await res.text();
        logger.error('[updateStoreVersion] GitHub dispatch error:', res.status, body);
        await storeRef.update({
          versionUpdateStatus: 'failed',
          redeployStatus: 'failed',
          redeployError: `No se pudo iniciar el flujo de actualización en GitHub Actions (${res.status}).`,
          updatedAt: new Date(),
        });
        throw new HttpsError('internal', `GitHub API error (${res.status}): ${body.slice(0, 200)}`);
      }
    } catch (dispatchErr) {
      if (dispatchErr instanceof HttpsError) {
        throw dispatchErr;
      }
      const msg = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
      logger.error('[updateStoreVersion] unexpected dispatch error:', dispatchErr);
      await storeRef.update({
        versionUpdateStatus: 'failed',
        redeployStatus: 'failed',
        redeployError: 'Error de red o conexión con GitHub Actions.',
        updatedAt: new Date(),
      });
      throw new HttpsError('internal', `Error conectando con el servicio de despliegue: ${msg}`);
    }

    await storeRef.update({
      versionUpdateStatus: 'updating',
      versionUpdateTarget: version,
      versionUpdateProgress: {
        step: 'Encolando deploy',
        pct: 5,
        updatedAt: new Date().toISOString(),
      },
      pendingMigration: needsMigration ? true : null,
      updatedAt: new Date(),
    });

    return { success: true };
  },
);

export const reportVersionUpdateProgress = onCall<{
  storeId: string;
  deployToken: string;
  step: string;
  pct: number;
}>({ cors: ALLOWED_ORIGINS, invoker: 'public' }, async (request) => {
  const { storeId, deployToken, step, pct } = request.data;
  if (!storeId || !deployToken || !step || typeof pct !== 'number') {
    throw new HttpsError('invalid-argument', 'storeId, deployToken, step and pct are required.');
  }

  // Misma verificación de deploy token que completeVersionUpdate (el workflow es quien reporta).
  const expected = await getDeployToken();
  if (deployToken !== expected) {
    throw new HttpsError('permission-denied', 'Invalid deploy token.');
  }

  const db = getFirestore();
  await db
    .collection('stores')
    .doc(storeId)
    .update({
      versionUpdateProgress: {
        step,
        pct: Math.max(0, Math.min(100, Math.round(pct))),
        updatedAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    });

  return { success: true };
});

export const completeVersionUpdate = onCall<{
  storeId: string;
  success: boolean;
  deployToken?: string;
  idToken?: string;
  version: string;
  commitSha?: string;
  commitMessage?: string;
  ref?: string;
}>({ cors: ALLOWED_ORIGINS, invoker: 'public' }, async (request) => {
  const { storeId, success, deployToken, idToken, version, commitSha, commitMessage, ref } =
    request.data;

  if (!storeId) {
    throw new HttpsError('invalid-argument', 'storeId is required.');
  }

  let authenticated = false;
  if (idToken) {
    authenticated = await verifyGitHubOidcToken(idToken, {
      repository: 'vertex-solutions-ar/ecommerce-vertex',
    });
  }
  if (!authenticated && deployToken) {
    const expected = await getDeployToken();
    if (deployToken === expected) {
      authenticated = true;
    }
  }
  if (!authenticated) {
    throw new HttpsError(
      'permission-denied',
      'A valid deploy token or GitHub OIDC token is required.',
    );
  }

  const db = getFirestore();
  const storeRef = db.collection('stores').doc(storeId);
  const snap = await storeRef.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'Store not found.');
  }

  const cleanVer = (version || '0.5.0').replace(/^v/, '');
  const schemaVer = getSchemaVersion(cleanVer);

  // Record deployment entry into store's deploy_history and deploys subcollections
  await recordStoreDeployHistory({
    db,
    storeId,
    success,
    version: cleanVer,
    commitSha: commitSha || '',
    commitMessage: commitMessage || '',
    ref: ref || '',
    error: success ? null : 'Storefront deployment failed. Check GitHub Action logs for details.',
  });

  if (success) {
    await storeRef.update({
      templateVersion: `v${cleanVer}`,
      appVersion: `v${cleanVer}`,
      targetChannel: 'stable',
      schemaVersion: schemaVer,
      versionUpdateStatus: 'idle',
      versionUpdateTarget: null,
      versionUpdateProgress: null,
      redeployStatus: 'idle',
      redeployError: null,
      pendingMigration: null,
      lastDeployedAt: new Date(),
      updatedAt: new Date(),
    });
  } else {
    await storeRef.update({
      versionUpdateStatus: 'failed',
      redeployStatus: 'failed',
      redeployError: 'El despliegue de actualización de plantilla falló.',
      updatedAt: new Date(),
    });
  }

  return { success: true };
});
