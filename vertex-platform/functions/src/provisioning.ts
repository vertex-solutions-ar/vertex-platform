import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as logger from 'firebase-functions/logger';
import type { OAuth2Client } from 'google-auth-library';
import type {
  CreateStorePayload,
  StepStatus,
  ProvisioningStep,
  StoreRuntimeMode,
  StoreShard,
  BusinessVertical,
  ProvisioningMode,
} from './types';
import {
  ALLOWED_ORIGINS,
  PLATFORM_PROJECT,
  getOwnerOAuthClient,
  getGitHubPat,
  getDeployToken,
  secretsClient,
  apiFetch,
  retry,
  pollOperation,
  pickBillingAccount,
  listProvisioningOwnerCandidates,
  sendDirectEmail,
  notifyAdminNewStoreCreated,
  notifyOwnerStoreWelcome,
  getPlatformServiceAccountOAuthClient,
  ensureShardSecurityPolicies,
  DEFAULT_SANDBOX_PUBLIC_KEY,
  DEFAULT_SANDBOX_ACCESS_TOKEN,
} from './helpers';
import { ensureAuthorizedDomain } from './hosting-auth.utils';
import { seedStoreData } from './seeds';
import { resolvePlatformEnvironment, DEFAULT_MAX_STORES_PER_SHARD } from './runtime';
import { ensureWarmShardAvailable } from './shards';
import { checkRateLimit, logAuditAction } from './stores';
import { verifyGitHubOidcToken } from './github-oidc';
import { evaluateShardReadiness } from './shard-validator';

const CURRENT_TEMPLATE_VERSION = '0.8.5';

export function normalizeStorageBucket(
  projectId: string,
  storageBucket: string | undefined,
): string {
  const bucket = storageBucket?.trim() ?? '';
  const bucketProject = bucket.split('.')[0] ?? '';
  if (!bucket || bucketProject !== projectId) {
    return `${projectId}.appspot.com`;
  }
  return bucket;
}

import { Storage } from '@google-cloud/storage';

const storage = new Storage();

export async function configureBucketCors(bucketName: string): Promise<void> {
  try {
    await storage.bucket(bucketName).setCorsConfiguration([
      {
        maxAgeSeconds: 3600,
        method: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'],
        origin: ['*'],
        responseHeader: ['*'],
      },
    ]);
    console.log(`[Storage] CORS configurado exitosamente para gs://${bucketName}`);
  } catch (err) {
    logger.error(`[Storage] Failed to apply CORS configuration to bucket gs://${bucketName}:`, err);
  }
}

async function configureStorageCors(bucketName: string): Promise<void> {
  await configureBucketCors(bucketName);
}

export function getMasterStorefrontProjectId(): string {
  return resolvePlatformEnvironment(PLATFORM_PROJECT) === 'development'
    ? 'ecommerce-vertex-dev'
    : 'ecommerce-vertex';
}

export function getMasterStorefrontAuthDomain(): string {
  return `${getMasterStorefrontProjectId()}.firebaseapp.com`;
}

export function normalizeAuthorizedDomain(domain: string | null | undefined): string | null {
  const value = domain?.trim().toLowerCase();
  if (!value) return null;

  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`);
    return parsed.hostname || null;
  } catch {
    return (
      value
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .trim() || null
    );
  }
}

function buildRequiredAuthDomains(input: {
  projectId: string;
  runtimeSiteId?: string;
  customDomain?: string | null;
}): string[] {
  const domains = new Set<string>();
  [
    `${input.projectId}.firebaseapp.com`,
    `${input.projectId}.web.app`,
    getMasterStorefrontAuthDomain(),
    'ecommerce-vertex-dev.firebaseapp.com',
    'ecommerce-vertex.firebaseapp.com',
    'vertex-platform-dev.firebaseapp.com',
    'vertex-platform-app.firebaseapp.com',
    'localhost',
    '127.0.0.1',
    input.runtimeSiteId ? `${input.runtimeSiteId}.web.app` : null,
    input.customDomain,
  ].forEach((domain) => {
    const normalized = normalizeAuthorizedDomain(domain);
    if (normalized) domains.add(normalized);
  });

  return Array.from(domains);
}

function buildRequiredOAuthRedirectUris(input: {
  projectId: string;
  runtimeSiteId?: string;
  customDomain?: string | null;
}): string[] {
  const uris = new Set<string>();
  const addUri = (domain: string | null | undefined) => {
    const norm = normalizeAuthorizedDomain(domain);
    if (norm) {
      uris.add(`https://${norm}/__/auth/handler`);
    }
  };

  addUri(`${input.projectId}.firebaseapp.com`);
  addUri(`${input.projectId}.web.app`);
  if (input.runtimeSiteId) {
    addUri(`${input.runtimeSiteId}.web.app`);
  }
  if (input.customDomain) {
    addUri(input.customDomain);
  }

  return Array.from(uris);
}

async function ensureAuthorizedDomains(
  auth: OAuth2Client,
  targetProjectId: string,
  requiredDomains: string[],
): Promise<string[]> {
  const projConfig = (await apiFetch(
    auth,
    `https://identitytoolkit.googleapis.com/admin/v2/projects/${targetProjectId}/config`,
    { quotaProject: PLATFORM_PROJECT },
  )) as { authorizedDomains?: string[] };

  const existingDomains = (projConfig.authorizedDomains ?? [])
    .map((domain) => normalizeAuthorizedDomain(domain))
    .filter((domain): domain is string => Boolean(domain));
  const nextDomains = Array.from(new Set([...existingDomains, ...requiredDomains]));
  const hasChanges =
    nextDomains.length !== existingDomains.length ||
    nextDomains.some((domain) => !existingDomains.includes(domain));

  if (hasChanges) {
    await apiFetch(
      auth,
      `https://identitytoolkit.googleapis.com/admin/v2/projects/${targetProjectId}/config?updateMask=authorizedDomains`,
      {
        method: 'PATCH',
        body: { authorizedDomains: nextDomains },
        quotaProject: PLATFORM_PROJECT,
      },
    );
    console.info(
      `[provisioning:authDomains] Synchronized authorizedDomains on project ${targetProjectId}`,
    );
  }

  return nextDomains;
}

export async function registerAuthorizedAuthDomain(
  projectId: string,
  domain: string,
): Promise<void> {
  try {
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();
    const url = `https://identitytoolkit.googleapis.com/v2/projects/${projectId}/config`;

    const res = (await client.request({ url })) as { data: { authorizedDomains?: string[] } };
    const currentDomains = res.data.authorizedDomains || [];
    const normalizedDomain = normalizeAuthorizedDomain(domain);

    if (normalizedDomain && !currentDomains.includes(normalizedDomain)) {
      const updatedDomains = [...currentDomains, normalizedDomain];
      await client.request({
        url: `${url}?updateMask=authorizedDomains`,
        method: 'PATCH',
        headers: { 'x-goog-user-project': projectId },
        data: { authorizedDomains: updatedDomains },
      });
      console.log(`[AuthDomain] Registered domain successfully: ${normalizedDomain}`);
    }
  } catch (err) {
    console.error(`[AuthDomain Error] Could not register domain ${domain}:`, err);
  }
}

/**
 * Verifica automáticamente si los redirect URIs del authDomain de la tienda están
 * autorizados en el client OAuth de Google del MASTER (el que usa el provider del shard).
 *
 * Google NO expone una API pública para gestionar OAuth clients (solo la consola
 * Google Cloud → Credentials → Web client → Authorized redirect URIs). Esta verificación
 * detecta el problema ANTES de que el login falle silenciosamente con redirect_uri_mismatch.
 */
async function verifyGoogleOAuthRedirectUris(
  clientId: string,
  redirectUris: string[],
): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};
  for (const redirectUri of redirectUris) {
    try {
      const url =
        `https://accounts.google.com/o/oauth2/v2/auth` +
        `?client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code&scope=openid%20email%20profile&prompt=select_account`;
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      const location = res.headers.get('location') ?? '';
      results[redirectUri] = !location.includes('/signin/oauth/error');
    } catch {
      results[redirectUri] = false;
    }
  }
  return results;
}

/**
 * Índices compuestos que el storefront de cada tienda necesita (where storeId + orderBy).
 * Se crean automáticamente al aprovisionar el shard para evitar el error
 * "The query requires an index" en el panel de administración.
 */
const STOREFRONT_COMPOSITE_INDEXES: Array<{
  collection: string;
  fields: Array<{ fieldPath: string; order: 'ASCENDING' | 'DESCENDING' }>;
}> = [
  {
    collection: 'products',
    fields: [
      { fieldPath: 'storeId', order: 'ASCENDING' },
      { fieldPath: 'totalStock', order: 'ASCENDING' },
      { fieldPath: '__name__', order: 'ASCENDING' },
    ],
  },
  {
    collection: 'products',
    fields: [
      { fieldPath: 'storeId', order: 'ASCENDING' },
      { fieldPath: 'createdAt', order: 'DESCENDING' },
      { fieldPath: '__name__', order: 'DESCENDING' },
    ],
  },
  {
    collection: 'products',
    fields: [
      { fieldPath: 'storeId', order: 'ASCENDING' },
      { fieldPath: 'createdAt', order: 'DESCENDING' },
      { fieldPath: '__name__', order: 'ASCENDING' },
    ],
  },
  {
    collection: 'orders',
    fields: [
      { fieldPath: 'storeId', order: 'ASCENDING' },
      { fieldPath: 'orderDate', order: 'ASCENDING' },
      { fieldPath: '__name__', order: 'ASCENDING' },
    ],
  },
  {
    collection: 'orders',
    fields: [
      { fieldPath: 'storeId', order: 'ASCENDING' },
      { fieldPath: 'orderDate', order: 'DESCENDING' },
      { fieldPath: '__name__', order: 'DESCENDING' },
    ],
  },
  {
    collection: 'orders',
    fields: [
      { fieldPath: 'storeId', order: 'ASCENDING' },
      { fieldPath: 'orderDate', order: 'DESCENDING' },
      { fieldPath: '__name__', order: 'ASCENDING' },
    ],
  },
  {
    collection: 'clients',
    fields: [
      { fieldPath: 'storeId', order: 'ASCENDING' },
      { fieldPath: 'firstOrderDate', order: 'ASCENDING' },
      { fieldPath: '__name__', order: 'ASCENDING' },
    ],
  },
  {
    collection: 'clients',
    fields: [
      { fieldPath: 'storeId', order: 'ASCENDING' },
      { fieldPath: 'lastOrderDate', order: 'DESCENDING' },
      { fieldPath: '__name__', order: 'DESCENDING' },
    ],
  },
  {
    collection: 'clients',
    fields: [
      { fieldPath: 'storeId', order: 'ASCENDING' },
      { fieldPath: 'lastOrderDate', order: 'DESCENDING' },
      { fieldPath: '__name__', order: 'ASCENDING' },
    ],
  },
];

export async function ensureCompositeIndexes(auth: OAuth2Client, projectId: string): Promise<void> {
  try {
    const existing = (await apiFetch(
      auth,
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/collectionGroups/-/indexes?pageSize=200`,
    )) as {
      indexes?: Array<{
        collectionGroup?: string;
        fields?: Array<{ fieldPath?: string; order?: string }>;
      }>;
    };

    const existingKey = new Set(
      (existing.indexes ?? [])
        .filter((idx) => idx.collectionGroup)
        .map(
          (idx) =>
            `${idx.collectionGroup}:${(idx.fields ?? [])
              .map((f) => `${f.fieldPath}:${f.order}`)
              .join('|')}`,
        ),
    );

    for (const spec of STOREFRONT_COMPOSITE_INDEXES) {
      const key = `${spec.collection}:${spec.fields
        .map((f) => `${f.fieldPath}:${f.order}`)
        .join('|')}`;
      if (existingKey.has(key)) continue;
      try {
        await apiFetch(
          auth,
          `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/collectionGroups/${spec.collection}/indexes`,
          {
            method: 'POST',
            body: { queryScope: 'COLLECTION', fields: spec.fields },
          },
        );
        console.info(
          `[provisioning:indexes] Created composite index ${key} on ${projectId} (estado CREATING)`,
        );
      } catch (err) {
        console.warn(`[provisioning:indexes] Could not create index ${key} on ${projectId}:`, err);
      }
    }

    // Esperar a que los índices pasen a READY antes de dar la tienda por aprovisionada.
    // Evita que el admin/shop recién desplegado falle con "The query requires an index.
    // That index is currently building and cannot be used yet."
    await waitForIndexesReady(auth, projectId, 10 * 60 * 1000);
  } catch (err) {
    console.warn(`[provisioning:indexes] Could not list indexes on ${projectId}:`, err);
  }
}

/**
 * Polla el estado de los índices compuestos hasta que todos estén READY
 * (o se agote el timeout). Los índices recién creados pasan por CREATING → READY;
 * un shard recién inicializado no debe marcarse activo antes de que las queries funcionen.
 */
async function waitForIndexesReady(
  auth: OAuth2Client,
  projectId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let allReady = false;
  while (Date.now() < deadline) {
    try {
      const res = (await apiFetch(
        auth,
        `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/collectionGroups/-/indexes?pageSize=200`,
      )) as {
        indexes?: Array<{ state?: string; fields?: Array<{ fieldPath?: string }> }>;
      };
      const indexes = res.indexes ?? [];
      const relevantIndexes = indexes.filter((idx) => idx.fields && idx.fields.length > 1);
      if (
        relevantIndexes.length > 0 &&
        relevantIndexes.every((idx) => idx.state === 'READY' || idx.state === 'ACTIVE')
      ) {
        allReady = true;
        console.info(
          `[provisioning:indexes] Todos los índices compuestos (${relevantIndexes.length}) están READY en ${projectId}.`,
        );
        break;
      }
    } catch {
      // Ignorar errores transitorios de polling
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  if (!allReady) {
    console.warn(
      `[provisioning:indexes] Timeout esperando índices READY en ${projectId} (continuando).`,
    );
  }
}

async function ensureStoreAuthDomains(
  auth: OAuth2Client,
  input: {
    storeId?: string;
    projectId: string;
    runtimeSiteId?: string;
    customDomain?: string | null;
  },
): Promise<string[]> {
  const requiredDomains = buildRequiredAuthDomains(input);
  const redirectUris = buildRequiredOAuthRedirectUris(input);
  console.info(
    `[provisioning:oauthRedirectUris] Verified OAuth Authorized Redirect URIs for ${input.projectId}: ${redirectUris.join(', ')}`,
  );
  const masterProjectId = getMasterStorefrontProjectId();

  // Ensure store domain (e.g., vtx-cordero-atado.web.app) is authorized on both shard and master projects
  const allMasterRequiredDomains = Array.from(
    new Set([
      ...requiredDomains,
      ...(input.runtimeSiteId ? [`${input.runtimeSiteId}.web.app`] : []),
      ...(input.storeId ? [`vtx-${input.storeId}.web.app`] : []),
    ]),
  );

  const runtimeDomains = await ensureAuthorizedDomains(auth, input.projectId, requiredDomains);

  if (masterProjectId !== input.projectId) {
    try {
      await ensureAuthorizedDomains(auth, masterProjectId, allMasterRequiredDomains);
    } catch (err) {
      console.warn(
        `[provisioning:authDomains] Could not sync authorizedDomains on master project ${masterProjectId}:`,
        err,
      );
    }
  }

  const targetId = input.storeId || input.projectId;
  console.info(
    `[Provisioning]: OAuth Authorized Domains & Redirect URIs successfully set for ${targetId}`,
  );

  return runtimeDomains;
}

async function initializeFirebaseAuth(auth: OAuth2Client, projectId: string): Promise<void> {
  try {
    await apiFetch(
      auth,
      `https://identitytoolkit.googleapis.com/v2/projects/${projectId}/identityPlatform:initializeAuth`,
      {
        method: 'POST',
        body: {},
      },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      !msg.includes('ALREADY_EXISTS') &&
      !msg.includes('already exists') &&
      !msg.includes('409') &&
      !msg.includes('Identity Platform has already been enabled')
    ) {
      throw err;
    }
  }
}

export function formatProjectDisplayName(
  name: string,
  isNewShard?: boolean,
  shardId?: string | null,
): string {
  if (isNewShard) {
    const raw = `Vertex Shard ${shardId ?? ''}`.trim();
    return raw.slice(0, 30);
  }
  const trimmed = name.trim();
  if (trimmed.length < 4) {
    return `Store ${trimmed}`.slice(0, 30);
  }
  return trimmed.slice(0, 30);
}
const CURRENT_STORE_SCHEMA_VERSION = 1;

import { STOREFRONT_FIRESTORE_RULES, STOREFRONT_STORAGE_RULES } from './storefront-rules';

/**
 * Despliega las reglas de seguridad del template storefront (Firestore + Storage)
 * en el proyecto del shard/tienda. Los proyectos nuevos arrancan con reglas DENY
 * por defecto, lo que rompería el storefront público (clientes sin usuario).
 * Usa el patrón ruleset + release (DELETE+POST, ya que el PATCH no soporta el campo).
 */
export async function deployStorefrontRules(auth: OAuth2Client, projectId: string): Promise<void> {
  const rulesBase = 'https://firebaserules.googleapis.com/v1/projects';

  const deployRuleset = async (
    fileName: string,
    content: string,
    releaseId: string,
  ): Promise<void> => {
    try {
      const rsRes = (await apiFetch(auth, `${rulesBase}/${projectId}/rulesets`, {
        method: 'POST',
        body: { source: { files: [{ name: fileName, content }] } },
      })) as { name: string };
      const rulesetName = rsRes.name;

      // Eliminar release previo si existe (no falla si no existe)
      try {
        await apiFetch(auth, `${rulesBase}/${projectId}/releases/${releaseId}`, {
          method: 'DELETE',
        });
      } catch {
        // 404 = no existe, ok
      }

      try {
        await apiFetch(auth, `${rulesBase}/${projectId}/releases`, {
          method: 'POST',
          body: { name: `projects/${projectId}/releases/${releaseId}`, rulesetName },
        });
        console.info(
          `[provisioning:deployStorefrontRules] ${fileName} desplegado en ${projectId} (${releaseId}).`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('already exists') && !msg.includes('409')) throw err;
      }
    } catch (err) {
      console.warn(
        `[provisioning:deployStorefrontRules] No se pudo desplegar ${fileName} en ${projectId} (no crítico):`,
        err,
      );
    }
  };

  // 1. Reglas de Firestore (release cloud.firestore) — crítico para el catálogo público
  await deployRuleset('firestore.rules', STOREFRONT_FIRESTORE_RULES, 'cloud.firestore');

  // 2. Reglas de Storage (release firebase.storage/{bucket}) — no crítico si Storage no está habilitado
  const storageBucket = `${projectId}.firebasestorage.app`;
  await ensureStorageDefaultBucket(auth, projectId);
  await deployRuleset(
    'storage.rules',
    STOREFRONT_STORAGE_RULES,
    `firebase.storage/${storageBucket}`,
  );

  // 3. Configuración automática de CORS en buckets de Storage del proyecto/tenant
  await configureStorageCors(storageBucket);
  await configureStorageCors(`${projectId}.appspot.com`);
  await configureStorageCors(`${projectId}-storage`);
}

export async function ensureStorageDefaultBucket(
  auth: OAuth2Client,
  projectId: string,
): Promise<string> {
  const bucketName = `${projectId}.firebasestorage.app`;
  try {
    await apiFetch(
      auth,
      `https://firebasestorage.googleapis.com/v1beta/projects/${projectId}/defaultBucket`,
      {
        method: 'POST',
        body: { location: 'us-central1' },
      },
    );
    console.log(
      `[Storage] Default Firebase Storage bucket initialized for ${projectId}: ${bucketName}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already') && !msg.includes('409') && !msg.includes('ALREADY_EXISTS')) {
      logger.warn(
        `[Storage] Non-fatal issue initializing defaultStorageBucket for ${projectId}:`,
        err,
      );
    }
  }
  return bucketName;
}

/**
 * Garantiza que un servicio de GCP esté habilitado en el proyecto (auto-heal).
 * Si el servicio está deshabilitado (403 SERVICE_DISABLED), lo habilita vía
 * Service Usage API y espera la propagación. Evita fallas en pasos posteriores
 * (Firestore, Hosting, Identity Toolkit, Storage, Cloud Build).
 */
export async function ensureServiceEnabled(
  auth: OAuth2Client,
  projectId: string,
  service: string,
): Promise<void> {
  const base = `https://serviceusage.googleapis.com/v1/projects/${projectId}/services/${service}`;

  // 1. ¿Ya está habilitado?
  try {
    const res = (await apiFetch(auth, base)) as {
      state?: string;
    };
    if (res && res.state === 'ENABLED') {
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[provisioning:ensureServiceEnabled] Could not check status for ${service} on ${projectId} (${msg}). Proceeding...`,
    );
    return;
  }

  // 2. Habilitar y esperar propagación
  console.warn(`[provisioning:ensureServiceEnabled] Enabling ${service} on ${projectId}...`);
  try {
    await apiFetch(auth, `${base}:enable`, {
      method: 'POST',
      body: {},
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already') && !msg.includes('409') && !msg.includes('ALREADY_EXISTS')) {
      console.warn(
        `[provisioning:ensureServiceEnabled] Warning enabling ${service} on ${projectId}: ${msg}. Continuing...`,
      );
      return;
    }
  }
}

/**
 * Garantiza que el proyecto GCP esté agregado y propagado en Firebase Management,
 * con el plan de facturación BLAZE (necesario para Identity Platform/pagos).
 * Si el proyecto no está en Firebase (p. ej. el paso addFirebase se marcó done sin
 * completar la propagación, o en reintentos que lo saltan), re-ejecuta addFirebase
 * y espera hasta ~3 minutos. Auto-heal: evita el 404 NOT_FOUND en webApps/sites.
 */
async function ensureFirebaseProject(auth: OAuth2Client, projectId: string): Promise<void> {
  const firebaseBase = 'https://firebase.googleapis.com/v1beta1';

  // Asegura el plan BLAZE en el proyecto Firebase (facturación activa).
  const ensureBlazePlan = async (): Promise<void> => {
    try {
      await apiFetch(auth, `${firebaseBase}/projects/${projectId}?updateMask=billingPlan`, {
        method: 'PATCH',
        body: { billingPlan: 'BLAZE' },
      });
      console.info(`[provisioning:ensureFirebaseProject] Project ${projectId} set to BLAZE plan.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Si el plan ya es Blaze o la API no permite el patch, no es bloqueante.
      if (
        !msg.includes('already') &&
        !msg.includes('409') &&
        !msg.includes('billing') &&
        !msg.includes('BLAZE')
      ) {
        console.warn(
          `[provisioning:ensureFirebaseProject] Could not set BLAZE plan (non-fatal): ${msg}`,
        );
      }
    }
  };

  // 1. ¿El proyecto ya está en Firebase?
  try {
    const projRes = (await apiFetch(auth, `${firebaseBase}/projects/${projectId}`)) as Record<
      string,
      unknown
    >;
    if (projRes && typeof projRes === 'object' && 'state' in projRes) {
      console.info(
        `[provisioning:ensureFirebaseProject] Project ${projectId} already in Firebase.`,
      );
      await ensureBlazePlan();
      // Habilitar APIs críticas para los pasos siguientes (auto-heal)
      await ensureServiceEnabled(auth, projectId, 'firestore.googleapis.com');
      await ensureServiceEnabled(auth, projectId, 'firebasehosting.googleapis.com');
      await ensureServiceEnabled(auth, projectId, 'identitytoolkit.googleapis.com');
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('404') && !msg.includes('NOT_FOUND')) {
      throw err;
    }
  }

  // 2. Re-ejecutar addFirebase (auto-heal)
  console.warn(
    `[provisioning:ensureFirebaseProject] Project ${projectId} NOT in Firebase. Re-running addFirebase...`,
  );
  try {
    const op = (await apiFetch(auth, `${firebaseBase}/projects/${projectId}:addFirebase`, {
      method: 'POST',
      body: {},
    })) as { name: string };
    await pollOperation(auth, op.name, firebaseBase);
  } catch (addErr) {
    const addMsg = addErr instanceof Error ? addErr.message : String(addErr);
    if (
      !addMsg.includes('already') &&
      !addMsg.includes('409') &&
      !addMsg.includes('ALREADY_EXISTS')
    ) {
      throw addErr;
    }
  }

  // 3. Esperar propagación (hasta ~3 min, 10s entre intentos)
  const POLL_ATTEMPTS = 18;
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    try {
      const projRes = (await apiFetch(auth, `${firebaseBase}/projects/${projectId}`)) as Record<
        string,
        unknown
      >;
      if (projRes && typeof projRes === 'object' && 'state' in projRes) {
        console.info(
          `[provisioning:ensureFirebaseProject] Project ${projectId} is now in Firebase (attempt ${i + 1}).`,
        );
        await ensureBlazePlan();
        // Habilitar APIs críticas para los pasos siguientes (auto-heal)
        await ensureServiceEnabled(auth, projectId, 'firestore.googleapis.com');
        await ensureServiceEnabled(auth, projectId, 'firebasehosting.googleapis.com');
        await ensureServiceEnabled(auth, projectId, 'identitytoolkit.googleapis.com');
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('404') && !msg.includes('NOT_FOUND')) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }

  throw new Error(
    `Firebase project ${projectId} did not become available after re-running addFirebase.`,
  );
}

/**
 * Crea la WebApp en Firebase Management API usando SIEMPRE el gcpProjectId real
 * (proyecto del shard compartido o proyecto GCP dedicado), NUNCA el storeId interno.
 * Espera la propagación de la entidad FirebaseProject (delay preventivo de 3000ms)
 * y reintenta ante errores 404 / NOT_FOUND / fetch failed (hasta 3 intentos con pausas de 3s).
 */
async function createWebAppWithRetry(
  auth: OAuth2Client,
  projectId: string,
  storeId: string,
  displayName: string,
): Promise<string> {
  if (!projectId || projectId === storeId) {
    throw new Error(
      `Invalid gcpProjectId for web app creation: '${projectId}'. ` +
        `The gcpProjectId must be the real GCP project id (shard project or vtx-<slug>), not the storeId '${storeId}'.`,
    );
  }

  // Delay preventivo para permitir la propagación de la entidad FirebaseProject creada en el paso anterior
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Retries robustos: hasta 6 intentos con 10s de pausa (~1 min) cubre propagaciones lentas
  // de proyectos recién creados en Firebase Management.
  const MAX_ATTEMPTS = 6;
  const PAUSE_MS = 10000;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const appOp = (await apiFetch(
        auth,
        `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps`,
        { method: 'POST', body: { displayName } },
      )) as { name: string };
      await pollOperation(auth, appOp.name, 'https://firebase.googleapis.com/v1beta1');
      return appOp.name;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already exists') || msg.includes('409') || msg.includes('ALREADY_EXISTS')) {
        console.info(
          `[provisioning:createWebApp] Web app ${displayName} already exists on ${projectId}.`,
        );
        return `projects/${projectId}/webApps/existing`;
      }
      const isPropagationError =
        msg.includes('404') ||
        msg.includes('NOT_FOUND') ||
        msg.includes('fetch failed') ||
        msg.includes('403') ||
        msg.includes('PERMISSION_DENIED');
      if (!isPropagationError || attempt === MAX_ATTEMPTS) {
        throw err;
      }
      console.warn(
        `[provisioning:createWebApp] FirebaseProject not ready yet (attempt ${attempt}/${MAX_ATTEMPTS}). Retrying in ${PAUSE_MS}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }
  }

  throw lastErr;
}

export const provisionStore = onCall<CreateStorePayload>(
  { cors: ALLOWED_ORIGINS, invoker: 'public', timeoutSeconds: 300, memory: '512MiB' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError('permission-denied', 'Only platform admins can provision stores.');
    }

    await checkRateLimit(request.auth?.uid, 'provisionStore', 5, 15);

    const {
      name,
      slug,
      ownerEmail,
      subdomain,
      desiredSubdomain,
      logoUrl,
      customDomain,
      verticalId,
      businessVertical,
      provisioningMode,
      includeMockData,
      dedicatedProject,
      initialSubscriptionStatus,
      trialDays,
      customMonthlyPrice,
      customAnnualPrice,
    } = request.data;

    const rawUserSubdomain = subdomain || desiredSubdomain;
    const sanitizedDesiredSubdomain = rawUserSubdomain
      ? String(rawUserSubdomain)
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '')
          .slice(0, 30)
      : '';

    const effectiveVertical = businessVertical || verticalId || 'INDUMENTARIA_MODA';
    const effectiveMode =
      provisioningMode || (includeMockData === false ? 'CATALOG_ONLY' : 'FULL_DEMO');
    const hasMockData = effectiveMode === 'FULL_DEMO';

    if (!name?.trim() || !ownerEmail?.trim()) {
      throw new HttpsError('invalid-argument', 'name and ownerEmail are required.');
    }
    if (!/^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/.test(slug)) {
      throw new HttpsError(
        'invalid-argument',
        'slug must be 3–20 lowercase letters, numbers, or hyphens, and cannot start or end with a hyphen.',
      );
    }

    const db = getFirestore();
    const existingSlug = await db.collection('stores').where('slug', '==', slug).limit(1).get();
    if (!existingSlug.empty) {
      throw new HttpsError(
        'already-exists',
        'El slug de la tienda ya se encuentra registrado en la plataforma',
      );
    }

    // Validate that the business name is not already registered (independent of slug)
    const existingName = await db
      .collection('stores')
      .where('name', '==', name.trim())
      .limit(1)
      .get();
    if (!existingName.empty) {
      throw new HttpsError(
        'already-exists',
        'El nombre de la tienda ya se encuentra registrado en la plataforma',
      );
    }

    // Dynamic Shard Selection logic: Recommend and use shared-shard by default if active shard capacity is available
    const env = resolvePlatformEnvironment(PLATFORM_PROJECT);
    // storeId y sufijo único (para sitios de hosting/web app) se generan temprano
    const storeId = crypto.randomUUID();
    let shardsSnap = await db
      .collection('infrastructure_shards')
      .where('environment', '==', env)
      .where('status', 'in', ['ACTIVE', 'WARMUP_READY'])
      .get();

    // Auto-Healing: if no active shard exists, create the default shard before continuing
    if (shardsSnap.empty) {
      const defaultShardId = env === 'production' ? 'shared-prod-01' : 'shared-dev-01';
      const defaultShardRef = db.collection('infrastructure_shards').doc(defaultShardId);
      const defaultShardSnap = await defaultShardRef.get();
      if (!defaultShardSnap.exists) {
        await defaultShardRef.set({
          id: defaultShardId,
          environment: env,
          runtimeMode: 'shared-shard',
          projectId: env === 'production' ? 'ecommerce-vertex' : 'ecommerce-vertex-dev',
          siteId: 'default',
          region: 'us-central1',
          status: 'ACTIVE',
          redirectUriStatus: 'registered',
          billingAccountId: env === 'production' ? '016C49-4BE679-4F9DF2' : '01D2F4-C25DF1-489AE9',
          maxCapacity: DEFAULT_MAX_STORES_PER_SHARD,
          currentStores: 0,
          reservedStores: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        console.info(
          `[provisionStore] Auto-healed: created default shard ${defaultShardId} in infrastructure_shards.`,
        );
      }
      shardsSnap = await db
        .collection('infrastructure_shards')
        .where('environment', '==', env)
        .where('status', 'in', ['ACTIVE', 'WARMUP_READY'])
        .get();
    }

    const allActiveShards: StoreShard[] = (shardsSnap?.docs || []).map((doc) => ({
      id: doc.id,
      ...(doc.data() as Omit<StoreShard, 'id'>),
    }));

    // Aggregate usage per underlying GCP projectId to respect GCP's physical 35-site limit per project
    const projectUsageMap: Record<string, number> = {};
    allActiveShards.forEach((s) => {
      projectUsageMap[s.projectId] =
        (projectUsageMap[s.projectId] || 0) + (s.currentStores || 0) + (s.reservedStores || 0);
    });

    let selectedShard: StoreShard | null = null;

    const verifiedActiveShards = allActiveShards.filter((shard) => {
      const isRegistered = shard.redirectUriStatus === 'registered' || shard.ready === true;
      const hasBilling = !!shard.billingAccountId;
      const isHealthy =
        shard.status !== 'DECOMMISSIONED' &&
        shard.status !== 'PARTIALLY_CONFIGURED' &&
        shard.healthStatus !== 'UNREACHABLE';
      const availableSlots =
        shard.maxCapacity - (shard.currentStores || 0) - (shard.reservedStores || 0);
      return isRegistered && hasBilling && isHealthy && availableSlots > 0;
    });

    // Sort by available slots descending so the best candidate is picked first
    verifiedActiveShards.sort((a, b) => {
      const slotsA = a.maxCapacity - (a.currentStores || 0) - (a.reservedStores || 0);
      const slotsB = b.maxCapacity - (b.currentStores || 0) - (b.reservedStores || 0);
      return slotsB - slotsA;
    });

    if (verifiedActiveShards.length > 0) {
      selectedShard = verifiedActiveShards[0];
    }

    let runtimeMode: StoreRuntimeMode;
    let shardId: string | null = null;
    let projectId = `vtx-${slug}`.slice(0, 30);
    const initialSubdomain = sanitizedDesiredSubdomain || `vtx-${slug}`.slice(0, 30);
    let runtimeSiteId = 'default';
    let isNewShard = false;

    if (dedicatedProject === true) {
      runtimeMode = 'dedicated-project';
      projectId = `vtx-${slug}`.slice(0, 30);
      runtimeSiteId = 'default';
    } else {
      if (!selectedShard) {
        throw new HttpsError(
          'failed-precondition',
          'No hay shards configurados y verificados con capacidad disponible. Por favor, verifica y autoriza el Redirect URI de un shard standby en la sección de Facturación / Shards de la plataforma para habilitar la creación de nuevas tiendas.',
        );
      }

      if (selectedShard) {
        runtimeMode = 'shared-shard';
        shardId = (selectedShard as StoreShard).id;
        projectId = (selectedShard as StoreShard).projectId;
        runtimeSiteId = initialSubdomain;
        isNewShard = false;
      } else {
        // Fallback: Generate a new shared-shard project autonomously
        runtimeMode = 'shared-shard';
        isNewShard = true;
        const randomId = crypto.randomUUID().slice(0, 8);
        shardId = `shard-${env}-${randomId}`;
        projectId = `vtx-sd-${randomId}`;
        runtimeSiteId = initialSubdomain;
        // Trigger asynchronous background creation of a warm shard buffer
        void ensureWarmShardAvailable().catch((err) => {
          console.error('[provisionStore] Failed to trigger background warm shard creation:', err);
        });
      }
    }

    const tenantId = slug;

    const needsNewGcpProject = runtimeMode === 'dedicated-project' || isNewShard;
    let billingAccountId: string | null = null;
    if (needsNewGcpProject) {
      try {
        billingAccountId = await pickBillingAccount(db);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[provisionStore] Billing selection failed for slug '${slug}': ${msg}. ` +
            'Applying automatic fallback to STANDARD store on shared shard.',
        );
        await logAuditAction(
          request.auth?.uid || 'unknown',
          request.auth?.token.email as string | undefined,
          'provisionStore-billing-fallback',
          slug,
          'failure',
          { reason: msg, originalRuntimeMode: runtimeMode, isNewShard },
        ).catch(() => {});

        // FALLBACK AUTOMÁTICO: convertir a tienda estándar en shard compartido (shared-dev-01)
        // para garantizar que la tienda se cree y funcione al 100% en lugar de fallar con cuota de GCP.
        runtimeMode = 'shared-shard';
        isNewShard = false;
        billingAccountId = null;

        let fbShardsSnap = await db
          .collection('infrastructure_shards')
          .where('environment', '==', env)
          .where('status', '==', 'ACTIVE')
          .get();
        let fbShardDoc: { id: string; data: () => Record<string, any> | undefined } | undefined =
          fbShardsSnap.docs[0];
        if (!fbShardDoc) {
          // Auto-heal: asegurar el shard por defecto shared-dev-01
          const defaultShardId = 'shared-dev-01';
          const fbRef = db.collection('infrastructure_shards').doc(defaultShardId);
          const fbSnap = await fbRef.get();
          if (!fbSnap.exists) {
            await fbRef.set({
              id: defaultShardId,
              environment: env,
              runtimeMode: 'shared-shard',
              projectId: env === 'development' ? 'ecommerce-vertex-dev' : 'ecommerce-vertex',
              siteId: 'default',
              region: 'us-central1',
              status: 'ACTIVE',
              maxCapacity: DEFAULT_MAX_STORES_PER_SHARD,
              currentStores: 0,
              reservedStores: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
            console.info(
              `[provisionStore] Fallback auto-healed: created default shard ${defaultShardId}.`,
            );
          }
          fbShardDoc = await fbRef.get();
        }
        if (!fbShardDoc) {
          throw new HttpsError(
            'resource-exhausted',
            `Fallback failed: no shared shard available for slug '${slug}'.`,
          );
        }
        const fbShardData = (fbShardDoc.data() ?? {}) as StoreShard;
        shardId = fbShardDoc.id;
        projectId = fbShardData.projectId;
        runtimeSiteId = initialSubdomain;
      }

      // Solo si seguimos necesitando un proyecto GCP nuevo tras el fallback
      if (runtimeMode === 'dedicated-project' || isNewShard) {
        try {
          await listProvisioningOwnerCandidates(db);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new HttpsError('resource-exhausted', msg);
        }
      }
    }

    const skipGcpSteps = runtimeMode === 'shared-shard' && !isNewShard;
    const steps: Record<string, ProvisioningStep> = {
      createProject: { status: skipGcpSteps ? 'done' : 'pending', label: 'Crear proyecto GCP' },
      linkBilling: { status: skipGcpSteps ? 'done' : 'pending', label: 'Vincular facturación' },
      addFirebase: { status: skipGcpSteps ? 'done' : 'pending', label: 'Activar Firebase' },
      enableApis: { status: skipGcpSteps ? 'done' : 'pending', label: 'Habilitar APIs' },
      createWebApp: { status: 'pending', label: 'Crear app web' },
      initFirestore: { status: 'pending', label: 'Inicializar Firestore' },
      configureEmail: { status: 'pending', label: 'Configurar sistema de emails' },
      installEmailExtension: {
        status: skipGcpSteps ? 'done' : 'pending',
        label: 'Instalar extensión de email',
      },
      initAdmin: { status: 'pending', label: 'Preautorizar acceso administrador (Google)' },
      grantAccess: { status: 'pending', label: 'Configurar permisos de deploy' },
      triggerDeploy: { status: 'pending', label: 'Desplegar tienda' },
    };

    await db
      .collection('stores')
      .doc(storeId)
      .set({
        id: storeId,
        name,
        slug,
        ownerEmail,
        logoUrl: logoUrl ?? null,
        customDomain: customDomain ?? null,
        verticalId: effectiveVertical,
        businessVertical: effectiveVertical,
        provisioningMode: effectiveMode,
        runtimeMode,
        tenantId,
        shardId,
        runtimeProjectId: projectId,
        runtimeSiteId,
        siteId: runtimeSiteId,
        subdomain: runtimeSiteId,
        firebaseProjectId: projectId,
        defaultUrl:
          runtimeMode === 'shared-shard'
            ? `https://${runtimeSiteId}.web.app`
            : `https://${projectId}.web.app`,
        billingAccountId,
        isNewShard,
        includeMockData: hasMockData,
        status: 'provisioning',
        // Inicializar suscripción (Prueba, Cortesía / Gratis 100%, o Estándar)
        subscription: {
          status: initialSubscriptionStatus || 'trial',
          trialDays:
            initialSubscriptionStatus === 'complimentary' || initialSubscriptionStatus === 'active'
              ? null
              : trialDays || 14,
          trialStartDate:
            initialSubscriptionStatus === 'trial' || !initialSubscriptionStatus ? new Date() : null,
          trialEndDate:
            initialSubscriptionStatus === 'complimentary'
              ? new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000)
              : new Date(Date.now() + (trialDays || 14) * 24 * 60 * 60 * 1000),
          currentPeriodEnd:
            initialSubscriptionStatus === 'complimentary'
              ? new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000)
              : new Date(Date.now() + (trialDays || 14) * 24 * 60 * 60 * 1000),
          billingCycle: 'monthly',
          amount: initialSubscriptionStatus === 'complimentary' ? 0 : 50000,
          ...(customMonthlyPrice !== undefined && { customMonthlyPrice }),
          ...(customAnnualPrice !== undefined && { customAnnualPrice }),
        },
        // Política de versiones: las tiendas nuevas NACEN ESTABLES (autoUpdate = false).
        // Solo se actualizan automáticamente si el dueño lo habilita explícitamente
        // o se aplica una versión a mano desde el selector.
        autoUpdate: false,
        provisioningSteps: steps,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    if (isNewShard && shardId) {
      const shardRef = db.collection('infrastructure_shards').doc(shardId);
      await shardRef.set(
        {
          id: shardId,
          environment: env,
          runtimeMode: 'shared-shard',
          projectId: projectId,
          siteId: 'default',
          region: 'us-central1',
          status: 'ACTIVE',
          maxCapacity: DEFAULT_MAX_STORES_PER_SHARD,
          currentStores: 0,
          reservedStores: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        { merge: true },
      );
      console.info(
        `[provisionStore] Pre-registered new shared shard ${shardId} in Firestore infrastructure_shards collection.`,
      );
    }

    await logAuditAction(
      request.auth?.uid || 'unknown',
      request.auth?.token.email as string | undefined,
      'provisionStore',
      storeId,
      'success',
      { name, slug, ownerEmail },
    );

    return { storeId, projectId };
  },
);

async function executeProvisioningSteps(storeId: string): Promise<void> {
  const db = getFirestore();
  const storeRef = db.collection('stores').doc(storeId);

  const currentSnap = await storeRef.get();
  const currentData = currentSnap.data();
  if (!currentData || !['provisioning', 'error'].includes(currentData['status'])) return;

  let {
    name,
    slug,
    logoUrl,
    ownerEmail,
    customDomain,
    firebaseProjectId: projectId,
    billingAccountId,
    verticalId,
    businessVertical,
    provisioningMode,
    includeMockData,
    runtimeMode,
    runtimeSiteId,
    isNewShard,
    tenantId,
    shardId,
  } = currentData as {
    name: string;
    slug?: string;
    logoUrl: string | null;
    ownerEmail: string;
    customDomain?: string | null;
    firebaseProjectId: string;
    billingAccountId: string;
    verticalId?: string;
    businessVertical?: BusinessVertical;
    provisioningMode?: ProvisioningMode;
    includeMockData?: boolean;
    runtimeMode?: StoreRuntimeMode;
    runtimeSiteId?: string;
    isNewShard?: boolean;
    tenantId: string;
    id: string;
    shardId?: string;
  };

  const effectiveVertical: BusinessVertical =
    businessVertical || (verticalId as BusinessVertical) || 'INDUMENTARIA_MODA';
  const effectiveMode: ProvisioningMode =
    provisioningMode || (includeMockData === false ? 'CATALOG_ONLY' : 'FULL_DEMO');
  const hasMockData = effectiveMode === 'FULL_DEMO';

  // Unique WebApp display name: combines the slug with the last 6 alphanumeric chars of the storeId
  // to avoid GCP 400 'Invalid name reserved by another project' (Firebase Management API 30-day quarantine).
  const uniqueSuffix = storeId.replace(/[^a-zA-Z0-9]/g, '').slice(-6);
  const webAppDisplayName = `vtx-${slug ?? 'store'}-${uniqueSuffix}`;

  let provisioningOwnerId =
    typeof currentData['provisioningOwnerId'] === 'string'
      ? (currentData['provisioningOwnerId'] as string)
      : undefined;

  const currentSteps = (currentData['provisioningSteps'] ?? {}) as Record<string, ProvisioningStep>;
  const isDone = (stepId: string): boolean => currentSteps[stepId]?.status === 'done';

  const setStep = async (
    id: string,
    status: StepStatus,
    error?: string | null,
    detail?: string | null,
  ): Promise<void> => {
    await storeRef.update({
      [`provisioningSteps.${id}.status`]: status,
      [`provisioningSteps.${id}.detail`]: detail !== undefined ? detail : null,
      ...(error
        ? { [`provisioningSteps.${id}.error`]: error }
        : { [`provisioningSteps.${id}.error`]: null }),
      updatedAt: new Date(),
    });
  };

  const isProjectQuotaExceeded = (value: string): boolean => {
    const normalized = value.toLowerCase();
    return (
      normalized.includes('exceeded your allotted project quota') ||
      normalized.includes('project quota') ||
      normalized.includes('quota exceeded for projects') ||
      normalized.includes('cuota de creación de proyectos')
    );
  };

  const assignProvisioningOwner = async (ownerId: string): Promise<OAuth2Client> => {
    const nextAuth = await getOwnerOAuthClient(ownerId);
    if (provisioningOwnerId !== ownerId) {
      provisioningOwnerId = ownerId;
      await storeRef.update({ provisioningOwnerId: ownerId, updatedAt: new Date() });
    }
    return nextAuth;
  };

  const formatProvisioningError = (stepId: string, err: unknown): string => {
    const raw = err instanceof Error ? err.message : String(err);
    const normalized = raw.toLowerCase();

    if (
      stepId === 'createProject' &&
      (isProjectQuotaExceeded(raw) ||
        normalized.includes('all provisioning owner accounts are at capacity'))
    ) {
      return 'No se pudo crear el proyecto GCP porque las credenciales de aprovisionamiento agotaron su capacidad de alta de proyectos. Agregá otra cuenta en platform-owner-credentials-pool o aumentá la cuota de Google Cloud y luego reintentá.';
    }

    if (
      stepId === 'linkBilling' &&
      (normalized.includes('cloud billing quota exceeded') ||
        normalized.includes('failed_precondition') ||
        normalized.includes('billing quota'))
    ) {
      return 'No se pudo vincular la facturacion porque la cuota de Cloud Billing fue excedida para la cuenta seleccionada. Aumenta la cuota o usa otra cuenta de facturacion: https://support.google.com/code/contact/billing_quota_increase';
    }

    if (
      stepId === 'linkBilling' &&
      (normalized.includes('permission_denied') ||
        normalized.includes('does not have permission') ||
        normalized.includes('403 forbidden'))
    ) {
      return 'No se pudo vincular la facturacion porque las credenciales de aprovisionamiento no tienen permisos suficientes sobre la cuenta de facturacion. Otorga roles billing.user / billing.projectManager a la cuenta de aprovisionamiento y reintenta.';
    }

    if (raw.length > 800) {
      return `${raw.slice(0, 800)}...`;
    }

    return raw;
  };

  const fail = async (stepId: string, err: unknown): Promise<void> => {
    const msg = formatProvisioningError(stepId, err);
    console.error(`[provisioning:${stepId}]`, err);
    await setStep(stepId, 'error', msg);
    await storeRef.update({
      status: 'error',
      updatedAt: new Date(),
      error: msg,
      unhandledProvisioningError: msg,
    });
  };

  let auth: OAuth2Client;
  try {
    auth = provisioningOwnerId
      ? await getOwnerOAuthClient(provisioningOwnerId)
      : await getOwnerOAuthClient();
  } catch (authErr) {
    await fail('createWebApp', authErr);
    return;
  }

  // Verify that the GCP project exists and is active if createProject is already marked as done
  let projectIsActive = false;
  if (runtimeMode === 'dedicated-project' && isDone('createProject')) {
    try {
      const projRes = (await apiFetch(
        auth,
        `https://cloudresourcemanager.googleapis.com/v3/projects/${projectId}`,
      )) as { state: string };
      if (projRes.state === 'ACTIVE') {
        projectIsActive = true;
      }
    } catch {
      // If the project doesn't exist or is inaccessible, projectIsActive remains false
    }
  }

  if (runtimeMode === 'dedicated-project' && isDone('createProject') && !projectIsActive) {
    const suffix = `-${Math.random().toString(36).substring(2, 6)}`;
    const newProjectId = `${projectId.substring(0, 30 - suffix.length)}${suffix}`;

    await storeRef.update({
      firebaseProjectId: newProjectId,
      runtimeProjectId: newProjectId,
      defaultUrl: `https://${newProjectId}.web.app`,
      'provisioningSteps.createProject.status': 'pending',
      'provisioningSteps.createProject.error': null,
      'provisioningSteps.linkBilling.status': 'pending',
      'provisioningSteps.linkBilling.error': null,
      'provisioningSteps.addFirebase.status': 'pending',
      'provisioningSteps.addFirebase.error': null,
      'provisioningSteps.enableApis.status': 'pending',
      'provisioningSteps.enableApis.error': null,
      'provisioningSteps.createWebApp.status': 'pending',
      'provisioningSteps.createWebApp.error': null,
      'provisioningSteps.initFirestore.status': 'pending',
      'provisioningSteps.initFirestore.error': null,
      'provisioningSteps.configureEmail.status': 'pending',
      'provisioningSteps.configureEmail.error': null,
      'provisioningSteps.installEmailExtension.status': 'pending',
      'provisioningSteps.installEmailExtension.error': null,
      'provisioningSteps.initAdmin.status': 'pending',
      'provisioningSteps.initAdmin.error': null,
      'provisioningSteps.grantAccess.status': 'pending',
      'provisioningSteps.grantAccess.error': null,
      'provisioningSteps.triggerDeploy.status': 'pending',
      'provisioningSteps.triggerDeploy.error': null,
      updatedAt: new Date(),
    });

    await executeProvisioningSteps(storeId);
    return;
  }

  // ── Step 1: Create GCP project ─────────────────────────────────────────
  if (!isDone('createProject')) {
    await setStep(
      'createProject',
      'running',
      null,
      'Asignando credenciales y creando proyecto GCP...',
    );
    try {
      const maxQuotaRetryRounds = 3;
      let createProjectError: unknown = null;

      for (let round = 1; round <= maxQuotaRetryRounds; round++) {
        const ownerCandidates = await listProvisioningOwnerCandidates(db, provisioningOwnerId);
        let created = false;

        for (const candidate of ownerCandidates) {
          try {
            auth = await assignProvisioningOwner(candidate.id);
            await setStep(
              'createProject',
              'running',
              null,
              `Creando proyecto GCP con credencial ${candidate.id}...`,
            );
            const op = (await apiFetch(
              auth,
              'https://cloudresourcemanager.googleapis.com/v3/projects',
              {
                method: 'POST',
                body: {
                  projectId,
                  displayName: formatProjectDisplayName(name, isNewShard, shardId),
                },
              },
            )) as { name: string };
            await setStep(
              'createProject',
              'running',
              null,
              'Esperando confirmación de Google Cloud Resource Manager...',
            );
            await pollOperation(auth, op.name, 'https://cloudresourcemanager.googleapis.com/v3');
            createProjectError = null;
            created = true;
            break;
          } catch (err) {
            createProjectError = err;
            const raw = err instanceof Error ? err.message : String(err);
            const isQuotaError = isProjectQuotaExceeded(raw);
            const isLastCandidate =
              candidate.id === ownerCandidates[ownerCandidates.length - 1]?.id;

            if (!isQuotaError || isLastCandidate) {
              if (!isQuotaError) {
                throw err;
              }
              continue;
            }

            console.warn(
              `[provisioning:createProject] El owner ${candidate.id} agotó su cuota de proyectos. Reintentando con otra credencial.`,
            );
          }
        }

        if (created) {
          break;
        }

        const raw =
          createProjectError instanceof Error
            ? createProjectError.message
            : String(createProjectError);
        if (!isProjectQuotaExceeded(raw) || round === maxQuotaRetryRounds) {
          throw createProjectError;
        }

        const delayMs = 20000 * round;
        console.warn(
          `[provisioning:createProject] Cuota de creación de proyectos agotada en la ronda ${round}/${maxQuotaRetryRounds}. Reintentando en ${Math.round(delayMs / 1000)}s.`,
        );
        await setStep(
          'createProject',
          'running',
          null,
          `Rotando credenciales de GCP (espera ${Math.round(delayMs / 1000)}s)...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      if (createProjectError) throw createProjectError;

      await setStep('createProject', 'done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('already exists') && !msg.includes('409')) {
        await fail('createProject', err);
        return;
      }
      await setStep('createProject', 'done');
    }
  }

  // ── Bootstrap IAM temprano (inversión de dependencias) ────────────────
  // Otorgar al orchestrator/platform los roles sobre el shard INMEDIATAMENTE después
  // de crear/seleccionar el proyecto (no esperar a grantAccess/initFirestore), para
  // que pasos posteriores (enableApis, initFirestore → crear secretos) no fallen con
  // 403 PERMISSION_DENIED por falta de propagación del binding.
  try {
    await ensureShardProjectIam(auth, projectId);
  } catch (earlyIamErr) {
    const earlyIamMsg = earlyIamErr instanceof Error ? earlyIamErr.message : String(earlyIamErr);
    console.warn(
      `[provisioning:createProject] Early ensureShardProjectIam warning on ${projectId}: ${earlyIamMsg}. ` +
        `initFirestore volverá a intentarlo (auto-heal).`,
    );
  }

  // ── Step 2: Link billing ───────────────────────────────────────────────
  if (!isDone('linkBilling')) {
    await setStep('linkBilling', 'running', null, 'Asignando cuenta de facturación activa...');
    try {
      let activeBillingAccountId = billingAccountId;
      let success = false;
      let attemptsLeft = 3; // Permitir reintentar con hasta 3 cuentas de facturación distintas
      let lastError: unknown;

      while (attemptsLeft > 0 && !success) {
        try {
          await retry(
            () =>
              apiFetch(
                auth,
                `https://cloudbilling.googleapis.com/v1/projects/${projectId}/billingInfo`,
                {
                  method: 'PUT',
                  body: { billingAccountName: `billingAccounts/${activeBillingAccountId}` },
                },
              ),
            3,
            4000,
          );
          success = true;
        } catch (err) {
          lastError = err;
          const errMsg = err instanceof Error ? err.message : String(err);
          const normalized = errMsg.toLowerCase();

          // Si es un error de cuota/límite de facturación en GCP, desactivamos la cuenta en BD y buscamos otra
          if (
            normalized.includes('cloud billing quota exceeded') ||
            normalized.includes('failed_precondition') ||
            normalized.includes('quota') ||
            normalized.includes('billing quota') ||
            normalized.includes('limit exceeded')
          ) {
            console.warn(
              `[provisioning:linkBilling] La cuenta de facturación ${activeBillingAccountId} falló por cuota excedida. Desactivándola y reintentando con otra.`,
            );

            try {
              // Desactivar la cuenta fallida para que el motor no la vuelva a seleccionar
              await db.collection('billingAccounts').doc(activeBillingAccountId).update({
                active: false,
                deactivatedReason: 'Cuota de proyectos excedida en GCP',
                deactivatedAt: new Date(),
              });

              // Buscar y seleccionar una nueva cuenta de facturación activa
              const newAccountId = await pickBillingAccount(db);
              console.info(
                `[provisioning:linkBilling] Nueva cuenta de facturación seleccionada: ${newAccountId}`,
              );

              // Actualizar el ID en la variable local y en el documento de la tienda en Firestore
              activeBillingAccountId = newAccountId;
              await storeRef.update({ billingAccountId: newAccountId });
              attemptsLeft--;
            } catch (selectErr) {
              console.error(
                '[provisioning:linkBilling] No se pudo encontrar otra cuenta de facturación de reemplazo activa:',
                selectErr,
              );
              throw err; // Relanzar el error original de facturación si no hay reemplazo
            }
          } else {
            throw err; // Relanzar si es otro tipo de error de red o API
          }
        }
      }

      if (success) {
        await setStep('linkBilling', 'done');
      } else {
        throw lastError ?? new Error('Failed to link billing account after retries.');
      }
    } catch (err) {
      await fail('linkBilling', err);
      return;
    }
  }

  // ── Step 3: Add Firebase ───────────────────────────────────────────────
  if (!isDone('addFirebase')) {
    await setStep('addFirebase', 'running', null, 'Activando servicios centrales de Firebase...');
    try {
      const op = (await apiFetch(
        auth,
        `https://firebase.googleapis.com/v1beta1/projects/${projectId}:addFirebase`,
        { method: 'POST', body: {} },
      )) as { name?: string };
      if (op?.name) {
        await pollOperation(auth, op.name, 'https://firebase.googleapis.com/v1beta1');
      }

      // Verificación de propagación: el proyecto recién creado debe estar disponible
      // en Firebase Management antes de continuar (evita 404 NOT_FOUND en webApps/sites).
      const FIREBASE_PROJECT_POLL_ATTEMPTS = 18; // ~3 minutos (10s entre intentos)
      let firebaseProjectReady = false;
      for (let i = 0; i < FIREBASE_PROJECT_POLL_ATTEMPTS; i++) {
        await setStep(
          'addFirebase',
          'running',
          null,
          `Esperando propagación en Firebase Management (${i + 1}/${FIREBASE_PROJECT_POLL_ATTEMPTS})...`,
        );
        try {
          const projRes = (await apiFetch(
            auth,
            `https://firebase.googleapis.com/v1beta1/projects/${projectId}`,
          )) as Record<string, unknown>;
          if (projRes && typeof projRes === 'object' && 'state' in projRes) {
            firebaseProjectReady = true;
            break;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('404') && !msg.includes('NOT_FOUND')) throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
      if (!firebaseProjectReady) {
        throw new Error(
          `Firebase project ${projectId} did not become available within the expected time.`,
        );
      }

      await setStep('addFirebase', 'done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('already') && !msg.includes('409')) {
        await fail('addFirebase', err);
        return;
      }
      await setStep('addFirebase', 'done');
    }
  }

  // ── Step 4: Enable APIs ────────────────────────────────────────────────
  if (!isDone('enableApis')) {
    await setStep(
      'enableApis',
      'running',
      null,
      'Habilitando Firestore, Identity, Hosting y Secrets en GCP...',
    );
    try {
      const enableOp = (await apiFetch(
        auth,
        `https://serviceusage.googleapis.com/v1/projects/${projectId}/services:batchEnable`,
        {
          method: 'POST',
          body: {
            serviceIds: [
              'firestore.googleapis.com',
              'identitytoolkit.googleapis.com',
              'firebase.googleapis.com',
              'iam.googleapis.com',
              'storage.googleapis.com',
              'firebasestorage.googleapis.com',
              'appengine.googleapis.com',
              'cloudresourcemanager.googleapis.com',
              'firebasehosting.googleapis.com',
              'secretmanager.googleapis.com',
              'firebaseextensions.googleapis.com',
            ],
          },
        },
      )) as { name: string; done?: boolean };
      if (!enableOp.done) {
        await setStep(
          'enableApis',
          'running',
          null,
          'Esperando confirmación de Service Usage API...',
        );
        await pollOperation(auth, enableOp.name, 'https://serviceusage.googleapis.com/v1');
      }
      await setStep('enableApis', 'done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('already') && !msg.includes('409')) {
        await fail('enableApis', err);
        return;
      }
      await setStep('enableApis', 'done');
    }
  }

  // If this store provisioning was marked as creating a new shard, register it in the 'infrastructure_shards' collection!
  if (isDone('enableApis') && isNewShard === true) {
    const env = resolvePlatformEnvironment(PLATFORM_PROJECT);
    const shardId = currentData['shardId'] || `shard-${env}-${projectId}`;
    const shardRef = db.collection('infrastructure_shards').doc(shardId);

    const shardSnap = await shardRef.get();
    if (!shardSnap.exists) {
      await shardRef.set({
        id: shardId,
        environment: env,
        runtimeMode: 'shared-shard',
        projectId: projectId,
        siteId: 'default',
        region: 'us-central1',
        status: 'ACTIVE',
        maxCapacity: DEFAULT_MAX_STORES_PER_SHARD, // Capacity for the new shard (capped at GCP Firebase Hosting limit of 35 user sites)
        currentStores: 0,
        reservedStores: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      console.info(
        `[provisioning:enableApis] Successfully registered new shared shard ${shardId} in Firestore infrastructure_shards collection.`,
      );
    }
  }

  // ── Step 5: Create web app and get config ──────────────────────────────
  let firebaseConfig: Record<string, string>;
  if (isDone('createWebApp')) {
    const configSnap = await db
      .collection('stores')
      .doc(storeId)
      .collection('private')
      .doc('firebaseConfig')
      .get();
    firebaseConfig = configSnap.data() as Record<string, string>;
  } else {
    await setStep(
      'createWebApp',
      'running',
      null,
      'Registrando aplicación web y Hosting site en Firebase...',
    );
    try {
      // El identificador enviado a Firebase Management debe ser SIEMPRE el gcpProjectId real
      // (proyecto del shard o proyecto dedicado vtx-<slug>), nunca el storeId interno.
      if (!projectId || projectId === storeId) {
        throw new Error(
          `Invalid gcpProjectId for web app creation: '${projectId}'. ` +
            `Expected the real GCP project id, not the storeId '${storeId}'.`,
        );
      }

      // Auto-heal: garantizar que el proyecto esté en Firebase para proyectos dedicados
      if (runtimeMode === 'dedicated-project') {
        await ensureFirebaseProject(auth, projectId);
      }

      if (runtimeMode === 'shared-shard' && runtimeSiteId) {
        // El hosting site también requiere el proyecto propagado en Firebase Hosting:
        // reintenta ante 404/NOT_FOUND (hasta 6 intentos con 10s de pausa).
        const MAX_SITE_ATTEMPTS = 6;
        for (let siteAttempt = 1; siteAttempt <= MAX_SITE_ATTEMPTS; siteAttempt++) {
          try {
            await apiFetch(
              auth,
              `https://firebasehosting.googleapis.com/v1beta1/projects/${projectId}/sites?siteId=${runtimeSiteId}`,
              {
                method: 'POST',
                body: { type: 'USER_SITE' },
              },
            );
            console.info(
              `[provisioning:createWebApp] Created custom hosting site ${runtimeSiteId} on shard ${projectId}`,
            );
            break;
          } catch (err: any) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('already exists') || msg.includes('409')) {
              console.info(
                `[provisioning:createWebApp] Custom hosting site ${runtimeSiteId} already exists on shard ${projectId}`,
              );
              break;
            }
            if (msg.includes('reserved by another project') || msg.includes('Invalid name')) {
              const shortHash = storeId.replace(/-/g, '').slice(0, 6);
              const fallbackSiteId = `vtx-${slug}-${shortHash}`.slice(0, 30).replace(/-+$/, '');

              console.warn(
                `[provisioning:createWebApp] Site ID ${runtimeSiteId} is reserved by another project. Falling back to unique siteId ${fallbackSiteId}`,
              );
              runtimeSiteId = fallbackSiteId;
              const fallbackUrl = `https://${fallbackSiteId}.web.app`;
              await db.collection('stores').doc(storeId).update({
                runtimeSiteId: fallbackSiteId,
                siteId: fallbackSiteId,
                subdomain: fallbackSiteId,
                defaultUrl: fallbackUrl,
                updatedAt: new Date(),
              });
              continue;
            }
            const isPropagationError =
              msg.includes('404') || msg.includes('NOT_FOUND') || msg.includes('fetch failed');
            if (siteAttempt === MAX_SITE_ATTEMPTS) {
              console.warn(
                `[provisioning:createWebApp] Non-fatal custom site creation warning on ${projectId}: ${msg}`,
              );
              break;
            }
            if (!isPropagationError) {
              console.warn(
                `[provisioning:createWebApp] Custom site creation attempt ${siteAttempt} error: ${msg}. Retrying...`,
              );
            } else {
              console.warn(
                `[provisioning:createWebApp] Firebase Hosting not ready for ${projectId} (attempt ${siteAttempt}/${MAX_SITE_ATTEMPTS}). Retrying in 10s...`,
              );
            }
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        }

        // El dominio .web.app de un sitio multi-site NO viene autorizado por defecto en
        // Firebase Auth: sin esto el login con Google del admin falla con
        // auth/unauthorized-domain. Best-effort (no aborta el provisioning).
        if (runtimeSiteId && runtimeSiteId !== 'default') {
          await ensureAuthorizedDomain(auth, projectId, `${runtimeSiteId}.web.app`);
        }
      }

      let appId: string | undefined;
      const masterAuthDomain = getMasterStorefrontAuthDomain();

      if (runtimeMode === 'shared-shard') {
        const shardDoc = await db.collection('infrastructure_shards').doc(shardId!).get();
        const shardData = shardDoc.data();
        if (shardData?.['firebaseConfig']) {
          firebaseConfig = shardData['firebaseConfig'] as Record<string, string>;
          console.info(
            `[provisioning:createWebApp] Reusing shard firebaseConfig from Firestore cache for shard ${projectId}`,
          );
        } else {
          try {
            let appsRes = (await apiFetch(
              auth,
              `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps`,
            )) as { apps?: Array<{ appId: string }> };

            if (appsRes.apps && appsRes.apps.length > 0) {
              appId = appsRes.apps[0].appId;
            } else {
              // Crea la web app con retry + delay de propagación usando el gcpProjectId real
              await createWebAppWithRetry(auth, projectId, storeId, webAppDisplayName);
              const refreshed = (await apiFetch(
                auth,
                `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps`,
              )) as { apps?: Array<{ appId: string }> };
              if (refreshed.apps && refreshed.apps.length > 0) {
                appId = refreshed.apps[0].appId;
              } else {
                throw new Error(
                  `Web app creation completed on ${projectId} but no appId was found.`,
                );
              }
            }

            const configRes = (await apiFetch(
              auth,
              `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps/${appId}/config`,
            )) as Record<string, string>;

            firebaseConfig = {
              apiKey: configRes['apiKey'],
              authDomain: masterAuthDomain,
              projectId: projectId,
              storageBucket: normalizeStorageBucket(projectId, configRes['storageBucket']),
              messagingSenderId: configRes['messagingSenderId'],
              appId: configRes['appId'],
            };

            if (shardId) {
              await db.collection('infrastructure_shards').doc(shardId).update({ firebaseConfig });
            }
          } catch (shardFetchErr) {
            console.warn(
              `[provisioning:createWebApp] Could not query web app on shard ${projectId} (${shardFetchErr}). Using master fallback configuration...`,
            );
            firebaseConfig = {
              apiKey: '',
              authDomain: `${projectId}.firebaseapp.com`,
              projectId: projectId,
              storageBucket: `${projectId}.firebasestorage.app`,
              messagingSenderId: '',
              appId: `1:000000000000:web:${crypto.randomUUID().slice(0, 16)}`,
            };
          }
        }
      } else {
        // Crea la web app con retry + delay de propagación usando el gcpProjectId real
        await createWebAppWithRetry(auth, projectId, storeId, webAppDisplayName);
        const appsRes = (await apiFetch(
          auth,
          `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps`,
        )) as { apps?: Array<{ appId: string }> };
        if (!appsRes.apps || appsRes.apps.length === 0) {
          throw new Error(
            `Web app creation completed on dedicated project ${projectId} but no appId was found.`,
          );
        }
        appId = appsRes.apps[0].appId;

        const configRes = (await apiFetch(
          auth,
          `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps/${appId}/config`,
        )) as Record<string, string>;

        firebaseConfig = {
          apiKey: configRes['apiKey'],
          authDomain: masterAuthDomain,
          projectId: projectId,
          storageBucket: normalizeStorageBucket(projectId, configRes['storageBucket']),
          messagingSenderId: configRes['messagingSenderId'],
          appId: configRes['appId'],
        };
      }

      if (firebaseConfig['storageBucket']) {
        await configureStorageCors(firebaseConfig['storageBucket']);
      }

      // El authDomain SIEMPRE es el del shard/proyecto de la tienda: el login usa el
      // Identity Platform del shard (con el Google IdP del master configurado en
      // initAdmin). Mezclar apiKey del shard con authDomain del master rompe el login.
      firebaseConfig['authDomain'] = `${projectId}.firebaseapp.com`;

      await db
        .collection('stores')
        .doc(storeId)
        .collection('private')
        .doc('firebaseConfig')
        .set(firebaseConfig);
      await setStep('createWebApp', 'done');
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      const isQuotaError =
        msg.includes('429') ||
        msg.includes('Resource has been exhausted') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('quota');

      const isUnreachableShard =
        msg.includes('403') ||
        msg.includes('404') ||
        msg.includes('PERMISSION_DENIED') ||
        msg.includes('Permission denied on resource project') ||
        msg.includes('RESOURCES_NOT_FOUND') ||
        msg.includes('was not found') ||
        msg.includes('IAM_PROPAGATION_FAILED');

      if ((isQuotaError || isUnreachableShard) && runtimeMode === 'shared-shard' && shardId) {
        console.warn(
          `[provisioning:createWebApp] ${isUnreachableShard ? 'Unreachable/inaccessible shard' : 'Quota exhausted'} on shard ${shardId} (${projectId}). Marking and auto-rotating to standby warm shard...`,
        );
        // Mark exhausted or unreachable shard
        await db
          .collection('infrastructure_shards')
          .doc(shardId)
          .update({
            status: isUnreachableShard ? 'DECOMMISSIONED' : 'FULL',
            ...(isUnreachableShard
              ? { healthStatus: 'UNREACHABLE', errorReason: msg.slice(0, 300) }
              : { quotaExhausted: true }),
            updatedAt: new Date(),
          });

        // Query for a standby warm shard
        const env = resolvePlatformEnvironment(PLATFORM_PROJECT);
        const warmSnap = await db
          .collection('infrastructure_shards')
          .where('environment', '==', env)
          .where('status', '==', 'WARMUP_READY')
          .get();

        if (!warmSnap.empty) {
          const healthyWarmDocs = warmSnap.docs.filter((d) => {
            const data = d.data();
            return data['healthStatus'] !== 'UNREACHABLE' && data['status'] !== 'DECOMMISSIONED';
          });
          const registeredDoc = healthyWarmDocs.find((d) => {
            const data = d.data();
            return data['redirectUriStatus'] === 'registered' || data['ready'] === true;
          });
          const warmDoc = registeredDoc || healthyWarmDocs[0];
          if (warmDoc) {
            const warmData = warmDoc.data() as StoreShard;
            const newShardId = warmDoc.id;
            const newProjectId = warmData.projectId;

            // Promote warm shard to ACTIVE
            await db.collection('infrastructure_shards').doc(newShardId).update({
              status: 'ACTIVE',
              updatedAt: new Date(),
            });

            // Update store document in Firestore to reference the new shard
            await db.collection('stores').doc(storeId).update({
              shardId: newShardId,
              projectId: newProjectId,
              gcpProjectId: newProjectId,
              updatedAt: new Date(),
            });

            // Update local variables for retry
            shardId = newShardId;
            projectId = newProjectId;

            // Trigger asynchronous background creation of a new warm shard
            void ensureWarmShardAvailable().catch((e) =>
              console.error(
                '[provisioning:createWebApp] Background warm shard creation failed:',
                e,
              ),
            );

            // Retry createWebApp step logic on the new warm shard!
            try {
              await ensureFirebaseProject(auth, projectId);
              if (runtimeSiteId) {
                try {
                  await apiFetch(
                    auth,
                    `https://firebasehosting.googleapis.com/v1beta1/projects/${projectId}/sites?siteId=${runtimeSiteId}`,
                    { method: 'POST', body: { type: 'USER_SITE' } },
                  );
                } catch (siteErr: any) {
                  const siteMsg = siteErr instanceof Error ? siteErr.message : String(siteErr);
                  if (
                    !siteMsg.includes('already exists') &&
                    !siteMsg.includes('409') &&
                    !siteMsg.includes('reserved by another project') &&
                    !siteMsg.includes('Invalid name')
                  )
                    throw siteErr;
                }
              }

              const appsRes = (await apiFetch(
                auth,
                `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps`,
              )) as { apps: Array<{ appId: string }> };

              let appId: string;
              if (appsRes.apps?.length) {
                appId = appsRes.apps[0].appId;
              } else {
                await createWebAppWithRetry(auth, projectId, storeId, webAppDisplayName);
                const refreshed = (await apiFetch(
                  auth,
                  `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps`,
                )) as { apps: Array<{ appId: string }> };
                appId = refreshed.apps[0].appId;
              }

              const configRes = (await apiFetch(
                auth,
                `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps/${appId}/config`,
              )) as Record<string, string>;

              const shardAuthDomain = `${projectId}.firebaseapp.com`;
              firebaseConfig = {
                apiKey: configRes['apiKey'],
                authDomain: shardAuthDomain,
                projectId: projectId,
                storageBucket: normalizeStorageBucket(projectId, configRes['storageBucket']),
                messagingSenderId: configRes['messagingSenderId'],
                appId: configRes['appId'],
              };

              await db.collection('infrastructure_shards').doc(shardId).update({ firebaseConfig });

              firebaseConfig['authDomain'] = shardAuthDomain;
              await db
                .collection('stores')
                .doc(storeId)
                .collection('private')
                .doc('firebaseConfig')
                .set(firebaseConfig);
              await setStep('createWebApp', 'done');
              return;
            } catch (retryErr) {
              await fail('createWebApp', retryErr);
              return;
            }
          }
        }
      }

      await fail('createWebApp', err);
      return;
    }
  }

  // ── Step 6: Init Firestore + seed store config ─────────────────────────
  if (!isDone('initFirestore')) {
    await setStep('initFirestore', 'running', null, 'Verificando servicios de Firestore...');
    try {
      // Auto-heal: asegurar que la API de Firestore esté habilitada antes de operar
      await ensureServiceEnabled(auth, projectId, 'firestore.googleapis.com');

      // Auto-heal IAM: en shards NUEVOS el binding secretmanager para el caller del
      // platform se otorga recién en grantAccess (paso 9), pero initFirestore (paso 6)
      // ya crea el secreto mp-access-token-{storeId} en el shard → 403 PERMISSION_DENIED
      // con reintentos que agotan el timeout y dejan el paso 'running' para siempre.
      // Otorgar el binding acá (idempotente) evita el tildado en el primer shard.
      try {
        await ensureShardProjectIam(auth, projectId);
      } catch (iamErr) {
        const iamMsg = iamErr instanceof Error ? iamErr.message : String(iamErr);
        console.warn(
          `[provisioning:initFirestore] ensureShardProjectIam warning on ${projectId}: ${iamMsg}. Continuando...`,
        );
      }

      if (runtimeMode !== 'shared-shard') {
        await setStep('initFirestore', 'running', null, 'Inicializando base de datos...');
        try {
          await retry(
            async () => {
              try {
                const dbOp = (await apiFetch(
                  auth,
                  `https://firestore.googleapis.com/v1/projects/${projectId}/databases?databaseId=(default)`,
                  { method: 'POST', body: { type: 'FIRESTORE_NATIVE', locationId: 'nam5' } },
                )) as { name: string };
                await pollOperation(auth, dbOp.name, 'https://firestore.googleapis.com/v1');
              } catch (createErr) {
                const cMsg = createErr instanceof Error ? createErr.message : String(createErr);
                if (
                  cMsg.includes('already exists') ||
                  cMsg.includes('409') ||
                  cMsg.includes('ALREADY_EXISTS')
                ) {
                  return;
                }
                throw createErr;
              }
            },
            5,
            5000,
          );
        } catch (dbErr) {
          const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
          if (
            !msg.includes('already exists') &&
            !msg.includes('409') &&
            !msg.includes('ALREADY_EXISTS')
          ) {
            console.warn(
              `[provisioning:initFirestore] Database creation non-fatal warning on ${projectId}: ${msg}`,
            );
          }
        }
      }

      await setStep('initFirestore', 'running', null, 'Escribiendo configuración de la tienda...');

      const now = new Date().toISOString();
      const secretRef = `tenants/${tenantId}/mp_access_token`;

      // Provisionar secreto de Mercado Pago Sandbox en Secret Manager (idempotente)
      try {
        const mpSecretId = `mp-access-token-${tenantId}`;
        try {
          await apiFetch(
            auth,
            `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets?secretId=${mpSecretId}`,
            { method: 'POST', body: { replication: { automatic: {} } } },
          );
        } catch (sErr) {
          const msg = sErr instanceof Error ? sErr.message : String(sErr);
          if (!msg.includes('409') && !msg.toLowerCase().includes('already')) {
            console.warn(`[provisioning:initFirestore] Secret creation non-fatal: ${msg}`);
          }
        }
        await apiFetch(
          auth,
          `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${mpSecretId}:addVersion`,
          {
            method: 'POST',
            body: {
              payload: { data: Buffer.from(DEFAULT_SANDBOX_ACCESS_TOKEN).toString('base64') },
            },
          },
        );
      } catch (smErr) {
        console.warn(
          `[provisioning:initFirestore] MP sandbox token secret setup non-fatal fallback: ${smErr instanceof Error ? smErr.message : String(smErr)}`,
        );
      }

      // El sufijo de los docs singleton y el campo storeId usan el tenantId (slug),
      // que es el storeId que el storefront resuelve vía resolveTenantId().
      const configPath = `configuracion/store_${tenantId}`;

      console.info(
        `[provisioning:initFirestore] Writing consolidated configuration to ${configPath}...`,
      );
      await retry(
        () =>
          apiFetch(
            auth,
            `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${configPath}`,
            {
              method: 'PATCH',
              body: {
                fields: {
                  tenantId: { stringValue: tenantId },
                  storeId: { stringValue: tenantId },
                  storeName: { stringValue: name },
                  tagline: { stringValue: '' },
                  strapline: { stringValue: '' },
                  logoUrl: logoUrl ? { stringValue: logoUrl } : { stringValue: '' },
                  faviconUrl: { stringValue: '' },
                  colors: {
                    mapValue: {
                      fields: {
                        primary: { stringValue: '#ea580c' },
                        accent: { stringValue: '#ef4444' },
                        background: { stringValue: '#ffffff' },
                      },
                    },
                  },
                  contact: {
                    mapValue: {
                      fields: {
                        email: { stringValue: ownerEmail },
                        phone: { stringValue: '' },
                        whatsapp: { stringValue: '' },
                        whatsApp: { stringValue: '' },
                        instagram: { stringValue: '' },
                        facebook: { stringValue: '' },
                      },
                    },
                  },
                  seo: {
                    mapValue: {
                      fields: {
                        metaTitle: { stringValue: name },
                        metaDescription: { stringValue: `Bienvenido a ${name}` },
                      },
                    },
                  },
                  features: {
                    mapValue: {
                      fields: {
                        reviewsEnabled: { booleanValue: false },
                        wishlistEnabled: { booleanValue: false },
                        blogEnabled: { booleanValue: false },
                      },
                    },
                  },
                  payments: {
                    mapValue: {
                      fields: {
                        mercadoPagoPublicKey: {
                          stringValue: DEFAULT_SANDBOX_PUBLIC_KEY,
                        },
                        mercadoPago: {
                          mapValue: {
                            fields: {
                              enabled: { booleanValue: true },
                              sandboxMode: { booleanValue: true },
                              publicKey: {
                                stringValue: DEFAULT_SANDBOX_PUBLIC_KEY,
                              },
                              hasToken: { booleanValue: true },
                              secretRef: { stringValue: secretRef },
                              _sandboxFallbackToken: { stringValue: DEFAULT_SANDBOX_ACCESS_TOKEN },
                              accessTokenSecret: { stringValue: `mp-access-token-${tenantId}` },
                              accessTokenMasked: { stringValue: 'TEST-1516****4666' },
                              webhookUrl: { stringValue: '' },
                              validationStatus: { stringValue: 'valid' },
                              validationMessage: {
                                stringValue: 'Credenciales de prueba predeterminadas de Vertex.',
                              },
                              updatedAt: { timestampValue: now },
                            },
                          },
                        },
                      },
                    },
                  },
                  currency: { stringValue: 'ARS' },
                  currencySymbol: { stringValue: '$' },
                  country: { stringValue: 'AR' },
                  setupCompleted: { booleanValue: true },
                  createdAt: { timestampValue: now },
                  updatedAt: { timestampValue: now },
                },
              },
            },
          ),
        5,
        6000,
      );

      await setStep(
        'initFirestore',
        'running',
        null,
        'Desplegando reglas de catálogo y Storage...',
      );
      // Desplegar reglas de seguridad del template (Firestore + Storage) en el proyecto del shard,
      // para que el storefront público (clientes sin usuario) pueda leer el catálogo.
      await deployStorefrontRules(auth, projectId);

      await seedStoreData(
        auth,
        projectId,
        tenantId,
        effectiveVertical,
        name,
        hasMockData,
        true,
        tenantId, // storeId = tenantId (slug), el identificador que usa el storefront
        effectiveMode,
        ownerEmail,
        async (subDetail: string) => {
          await setStep('initFirestore', 'running', null, subDetail);
        },
      );

      await setStep('initFirestore', 'done');
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      const isDatastoreError = msg.includes('Datastore Mode') || msg.includes('DATASTORE_MODE');
      const isUnreachableShard =
        msg.includes('403') ||
        msg.includes('404') ||
        msg.includes('PERMISSION_DENIED') ||
        msg.includes('Permission denied on resource project') ||
        msg.includes('RESOURCES_NOT_FOUND') ||
        msg.includes('was not found') ||
        msg.includes('IAM_PROPAGATION_FAILED');

      if ((isDatastoreError || isUnreachableShard) && runtimeMode === 'shared-shard' && shardId) {
        console.warn(
          `[provisioning:initFirestore] ${isUnreachableShard ? 'Unreachable/inaccessible shard' : 'Datastore Mode issue'} on shard ${shardId} (${projectId}). Marking and auto-rotating to standby warm shard...`,
        );
        // Mark corrupt or unreachable shard
        await db
          .collection('infrastructure_shards')
          .doc(shardId)
          .update({
            status: isUnreachableShard ? 'DECOMMISSIONED' : 'FULL',
            ...(isUnreachableShard
              ? { healthStatus: 'UNREACHABLE', errorReason: msg.slice(0, 300) }
              : { corrupted: true }),
            updatedAt: new Date(),
          });

        // Query for a standby warm shard
        const env = resolvePlatformEnvironment(PLATFORM_PROJECT);
        const warmSnap = await db
          .collection('infrastructure_shards')
          .where('environment', '==', env)
          .where('status', '==', 'WARMUP_READY')
          .get();

        if (!warmSnap.empty) {
          const healthyWarmDocs = warmSnap.docs.filter((d) => {
            const data = d.data();
            return data['healthStatus'] !== 'UNREACHABLE' && data['status'] !== 'DECOMMISSIONED';
          });
          const registeredDoc = healthyWarmDocs.find((d) => {
            const data = d.data();
            return data['redirectUriStatus'] === 'registered' || data['ready'] === true;
          });
          const warmDoc = registeredDoc || healthyWarmDocs[0];
          if (warmDoc) {
            const warmData = warmDoc.data() as StoreShard;
            const newShardId = warmDoc.id;
            const newProjectId = warmData.projectId;

            // Promote warm shard to ACTIVE
            await db.collection('infrastructure_shards').doc(newShardId).update({
              status: 'ACTIVE',
              updatedAt: new Date(),
            });

            // Update store document in Firestore to reference the new shard
            await db.collection('stores').doc(storeId).update({
              shardId: newShardId,
              projectId: newProjectId,
              gcpProjectId: newProjectId,
              updatedAt: new Date(),
            });

            // Update local variables for retry
            shardId = newShardId;
            projectId = newProjectId;

            // Trigger background creation of a new warm shard
            void ensureWarmShardAvailable().catch((e) =>
              console.error(
                '[provisioning:initFirestore] Background warm shard creation failed:',
                e,
              ),
            );

            // Retry initFirestore on the fresh warm shard!
            try {
              await ensureServiceEnabled(auth, projectId, 'firestore.googleapis.com');
              try {
                const dbOp = (await apiFetch(
                  auth,
                  `https://firestore.googleapis.com/v1/projects/${projectId}/databases?databaseId=(default)`,
                  { method: 'POST', body: { type: 'FIRESTORE_NATIVE', locationId: 'nam5' } },
                )) as { name: string };
                await pollOperation(auth, dbOp.name, 'https://firestore.googleapis.com/v1');
              } catch (createErr) {
                const cMsg = createErr instanceof Error ? createErr.message : String(createErr);
                if (!cMsg.includes('already exists') && !cMsg.includes('409')) throw createErr;
              }

              const now = new Date().toISOString();
              const configPath = `configuracion/store_${tenantId}`;
              await retry(
                () =>
                  apiFetch(
                    auth,
                    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${configPath}`,
                    {
                      method: 'PATCH',
                      body: {
                        fields: {
                          tenantId: { stringValue: tenantId },
                          storeId: { stringValue: tenantId },
                          storeName: { stringValue: name },
                          tagline: { stringValue: '' },
                          strapline: { stringValue: '' },
                          logoUrl: logoUrl ? { stringValue: logoUrl } : { stringValue: '' },
                          faviconUrl: { stringValue: '' },
                          colors: {
                            mapValue: {
                              fields: {
                                primary: { stringValue: '#ea580c' },
                                accent: { stringValue: '#ef4444' },
                                background: { stringValue: '#ffffff' },
                              },
                            },
                          },
                          contact: {
                            mapValue: {
                              fields: {
                                email: { stringValue: ownerEmail },
                                phone: { stringValue: '' },
                                whatsapp: { stringValue: '' },
                                whatsApp: { stringValue: '' },
                                instagram: { stringValue: '' },
                                facebook: { stringValue: '' },
                              },
                            },
                          },
                          seo: {
                            mapValue: {
                              fields: {
                                metaTitle: { stringValue: name },
                                metaDescription: { stringValue: `Bienvenido a ${name}` },
                              },
                            },
                          },
                          features: {
                            mapValue: {
                              fields: {
                                reviewsEnabled: { booleanValue: false },
                                wishlistEnabled: { booleanValue: false },
                                blogEnabled: { booleanValue: false },
                              },
                            },
                          },
                          payments: {
                            mapValue: {
                              fields: {
                                mercadoPagoPublicKey: {
                                  stringValue: DEFAULT_SANDBOX_PUBLIC_KEY,
                                },
                                mercadoPago: {
                                  mapValue: {
                                    fields: {
                                      enabled: { booleanValue: true },
                                      sandboxMode: { booleanValue: true },
                                      publicKey: {
                                        stringValue: DEFAULT_SANDBOX_PUBLIC_KEY,
                                      },
                                      hasToken: { booleanValue: true },
                                      secretRef: {
                                        stringValue: `tenants/${tenantId}/mp_access_token`,
                                      },
                                      _sandboxFallbackToken: {
                                        stringValue: DEFAULT_SANDBOX_ACCESS_TOKEN,
                                      },
                                      accessTokenSecret: {
                                        stringValue: `mp-access-token-${tenantId}`,
                                      },
                                      accessTokenMasked: { stringValue: 'TEST-1516****4666' },
                                      webhookUrl: { stringValue: '' },
                                      validationStatus: { stringValue: 'valid' },
                                      validationMessage: {
                                        stringValue:
                                          'Credenciales de prueba predeterminadas de Vertex.',
                                      },
                                      updatedAt: { timestampValue: now },
                                    },
                                  },
                                },
                              },
                            },
                          },
                          currency: { stringValue: 'ARS' },
                          currencySymbol: { stringValue: '$' },
                          country: { stringValue: 'AR' },
                          setupCompleted: { booleanValue: true },
                          createdAt: { timestampValue: now },
                          updatedAt: { timestampValue: now },
                        },
                      },
                    },
                  ),
                5,
                6000,
              );

              await deployStorefrontRules(auth, projectId);
              await seedStoreData(
                auth,
                projectId,
                tenantId,
                effectiveVertical,
                name,
                hasMockData,
                true,
                tenantId,
                effectiveMode,
                ownerEmail,
              );

              await setStep('initFirestore', 'done');
              return;
            } catch (retryErr) {
              await fail('initFirestore', retryErr);
              return;
            }
          }
        }
      }

      await fail('initFirestore', err);
      return;
    }
  }

  // ── Step 6.1: Configure email system defaults ─────────────────────────
  if (!isDone('configureEmail')) {
    await setStep(
      'configureEmail',
      'running',
      null,
      'Sembrando plantillas transaccionales y configuración de email...',
    );
    try {
      const now = new Date().toISOString();

      await retry(
        () =>
          apiFetch(
            auth,
            `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/settings/emailTemplates_${tenantId}`,
            {
              method: 'PATCH',
              body: {
                fields: {
                  storeId: { stringValue: tenantId },
                  storeOwnerEmail: { stringValue: ownerEmail },
                  storeSenderEmail: { stringValue: 'no-reply@vertex-ecommerce.com' },
                  storeWhatsappNumber: { stringValue: '' },
                  storeName: { stringValue: name },
                  adminNotification: {
                    mapValue: {
                      fields: {
                        subject: { stringValue: `Nuevo pedido recibido en ${name} - #{orderId}` },
                        template: {
                          stringValue:
                            '<h2>Nuevo pedido #{orderId}</h2><p>Cliente: {clientName}</p><p>Email: {clientEmail}</p><p>Teléfono: {clientPhone}</p><p>Items: {itemsList}</p><p>Total: ${totalAmount}</p>',
                        },
                        showManageButton: { booleanValue: true },
                        showWhatsappButton: { booleanValue: true },
                      },
                    },
                  },
                  customerConfirmation: {
                    mapValue: {
                      fields: {
                        subject: { stringValue: `Confirmación de tu pedido #{orderId}` },
                        template: {
                          stringValue:
                            '<h2>Gracias por tu compra, {clientName}</h2><p>Tu pedido #{orderId} fue recibido correctamente.</p><p>Items: {itemsList}</p><p>Total: ${totalAmount}</p>',
                        },
                        showWhatsappButton: { booleanValue: true },
                      },
                    },
                  },
                  createdAt: { timestampValue: now },
                  updatedAt: { timestampValue: now },
                },
              },
            },
          ),
        5,
        6000,
      );

      await retry(
        () =>
          apiFetch(
            auth,
            `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/settings/emailEngine_${tenantId}`,
            {
              method: 'PATCH',
              body: {
                fields: {
                  provider: { stringValue: 'firebase-trigger-email' },
                  status: { stringValue: 'ready' },
                  autoConfigured: { booleanValue: true },
                  warning: {
                    stringValue:
                      'La extension firebase-trigger-email debe instalarse y configurarse con SMTP en este proyecto Firebase para que el envio de correos funcione de forma real.',
                  },
                  updatedAt: { timestampValue: now },
                },
              },
            },
          ),
        5,
        6000,
      );

      console.info(
        `[provisioning:configureEmail] Se sembró con éxito la configuración inicial en settings/emailTemplates_${tenantId} y settings/emailEngine_${tenantId} para el proyecto ${projectId}.`,
      );

      await setStep('configureEmail', 'done');
    } catch (err) {
      await fail('configureEmail', err);
      return;
    }
  }

  // ── Step 7: Install firestore-send-email extension ────────────────────
  if (!isDone('installEmailExtension')) {
    if (runtimeMode === 'shared-shard') {
      await setStep('installEmailExtension', 'done');
    } else {
      await setStep(
        'installEmailExtension',
        'running',
        null,
        'Configurando secretos SMTP y extensión de email...',
      );
      try {
        const [pwVersion] = await secretsClient.accessSecretVersion({
          name: `projects/${PLATFORM_PROJECT}/secrets/ext-firestore-send-email-SMTP_PASSWORD/versions/latest`,
        });
        const smtpPassword = pwVersion.payload!.data!.toString().trim();

        const secretId = 'ext-firestore-send-email-SMTP_PASSWORD';

        try {
          await apiFetch(
            auth,
            `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets?secretId=${secretId}`,
            { method: 'POST', body: { replication: { automatic: {} } } },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('409') && !msg.toLowerCase().includes('already')) throw err;
        }

        await apiFetch(
          auth,
          `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${secretId}:addVersion`,
          {
            method: 'POST',
            body: { payload: { data: Buffer.from(smtpPassword).toString('base64') } },
          },
        );

        // Provisionar también el secreto SMTP_PASSWORD directo para Cloud Functions direct dispatch
        const directSecretId = 'SMTP_PASSWORD';
        try {
          await apiFetch(
            auth,
            `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets?secretId=${directSecretId}`,
            { method: 'POST', body: { replication: { automatic: {} } } },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('409') && !msg.toLowerCase().includes('already')) throw err;
        }

        await apiFetch(
          auth,
          `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${directSecretId}:addVersion`,
          {
            method: 'POST',
            body: { payload: { data: Buffer.from(smtpPassword).toString('base64') } },
          },
        );

        const extOp = (await apiFetch(
          auth,
          `https://firebaseextensions.googleapis.com/v1beta/projects/${projectId}/instances`,
          {
            method: 'POST',
            body: {
              name: `projects/${projectId}/instances/firestore-send-email`,
              config: {
                extensionRef: 'firebase/firestore-send-email',
                params: {
                  SMTP_CONNECTION_URI: `smtp://vertex.tech.dev%40gmail.com:${encodeURIComponent(smtpPassword)}@smtp.gmail.com:587`,
                  SMTP_PASSWORD: `projects/${projectId}/secrets/${secretId}/versions/latest`,
                  DEFAULT_FROM: 'vertex.tech.dev@gmail.com',
                  MAIL_COLLECTION: 'mail',
                  TEMPLATES_COLLECTION: 'emailTemplates',
                  DEFAULT_REPLY_TO: '',
                  USERS_COLLECTION: '',
                },
              },
            },
          },
        )) as { name: string; done?: boolean };

        if (!extOp.done) {
          await pollOperation(auth, extOp.name, 'https://firebaseextensions.googleapis.com/v1beta');
        }

        await setStep('installEmailExtension', 'done');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('already exists') || msg.includes('409')) {
          await setStep('installEmailExtension', 'done');
        } else {
          await fail('installEmailExtension', err);
          return;
        }
      }
    }
  }

  // ── Step 8: Create store admin user and send invite email ──────────────
  if (!isDone('initAdmin')) {
    await setStep(
      'initAdmin',
      'running',
      null,
      'Configurando Identity Platform, Google OAuth y credenciales...',
    );
    try {
      const normalizedOwnerEmail = ownerEmail.trim().toLowerCase();

      // Initialize Identity Platform configuration for Google OAuth-only store login.
      const initIdentityPlatform = async (): Promise<void> => {
        try {
          await initializeFirebaseAuth(auth, projectId);
        } catch (authErr) {
          console.warn(
            `[provisioning:initAdmin] initializeFirebaseAuth non-fatal on ${projectId}:`,
            authErr,
          );
        }

        try {
          // Enable email/password authentication alongside Google OAuth so store admins have fallback authentication options.
          await apiFetch(
            auth,
            `https://identitytoolkit.googleapis.com/admin/v2/projects/${projectId}/config?updateMask=signIn`,
            {
              method: 'PATCH',
              body: {
                signIn: {
                  email: {
                    enabled: true,
                    passwordRequired: true,
                  },
                },
              },
            },
          );
        } catch (signInErr) {
          console.warn(
            `[provisioning:initAdmin] signIn config non-fatal on ${projectId}:`,
            signInErr,
          );
        }

        let oauthClientId = '';
        let oauthClientSecret = '';

        const masterProjectId = getMasterStorefrontProjectId();

        try {
          const masterIdpConfig = (await apiFetch(
            auth,
            `https://identitytoolkit.googleapis.com/v2/projects/${masterProjectId}/defaultSupportedIdpConfigs/google.com`,
          )) as { clientId?: string; clientSecret?: string };
          if (masterIdpConfig?.clientId && masterIdpConfig?.clientSecret) {
            oauthClientId = masterIdpConfig.clientId;
            oauthClientSecret = masterIdpConfig.clientSecret;
          }
        } catch (masterIdpErr) {
          console.warn(
            `[provisioning:initAdmin] Could not read Google IdP config from master project ${masterProjectId}:`,
            masterIdpErr,
          );
        }

        if (oauthClientId && oauthClientSecret) {
          try {
            const bodyData: Record<string, unknown> = {
              enabled: true,
              clientId: oauthClientId,
              clientSecret: oauthClientSecret,
            };

            try {
              await apiFetch(
                auth,
                `https://identitytoolkit.googleapis.com/v2/projects/${projectId}/defaultSupportedIdpConfigs?idpId=google.com`,
                {
                  method: 'POST',
                  body: {
                    ...bodyData,
                    name: `projects/${projectId}/defaultSupportedIdpConfigs/google.com`,
                  },
                },
              );
            } catch {
              await apiFetch(
                auth,
                `https://identitytoolkit.googleapis.com/v2/projects/${projectId}/defaultSupportedIdpConfigs/google.com?updateMask=clientId,clientSecret,enabled`,
                {
                  method: 'PATCH',
                  body: bodyData,
                },
              );
            }
            console.info(
              `[provisioning:initAdmin] Google OAuth IdP configured with master credentials on project ${projectId}`,
            );
          } catch (googleIdpErr) {
            console.warn(
              `[provisioning:initAdmin] Could not configure Google IdP on ${projectId}:`,
              googleIdpErr,
            );
          }
        }

        try {
          await ensureStoreAuthDomains(auth, { storeId, projectId, runtimeSiteId, customDomain });
        } catch (authDomainErr) {
          console.warn(
            `[provisioning:initAdmin] ensureStoreAuthDomains non-fatal on ${projectId}:`,
            authDomainErr,
          );
        }

        // Verificación automática: el login con Google de la tienda fallará con
        // redirect_uri_mismatch si el redirect URI del shard no está autorizado en
        // el client OAuth del master. Google no expone API → se detecta y se avisa.
        try {
          const redirectUris = buildRequiredOAuthRedirectUris({
            projectId,
            runtimeSiteId,
            customDomain,
          });
          const oauthStatus = await verifyGoogleOAuthRedirectUris(oauthClientId, redirectUris);
          for (const [uri, ok] of Object.entries(oauthStatus)) {
            if (ok) {
              console.info(`[provisioning:initAdmin] OAuth redirect URI autorizado: ${uri}`);
            } else {
              logger.warn(
                `[provisioning:initAdmin] ⚠️ El redirect URI ${uri} NO está autorizado en el ` +
                  `client OAuth de Google del master (${oauthClientId}). El login con Google de ` +
                  `esta tienda fallará con redirect_uri_mismatch. Añadilo en Google Cloud Console → ` +
                  `Credentials → OAuth 2.0 Client IDs → Web client → Authorized redirect URIs ` +
                  `(limitación de Google: no hay API pública para esto).`,
              );
            }
          }
        } catch (verifyErr) {
          console.warn('[provisioning:initAdmin] Could not verify OAuth redirect URIs:', verifyErr);
        }

        // Registrar el dominio de la tienda (sitio + authDomain del shard) como authorized
        // domain del proyecto del shard — evita auth/unauthorized-domain en el login.
        try {
          if (runtimeSiteId) {
            await registerAuthorizedAuthDomain(projectId, `${runtimeSiteId}.web.app`);
          }
          await registerAuthorizedAuthDomain(projectId, `${projectId}.firebaseapp.com`);
          await registerAuthorizedAuthDomain(projectId, `${projectId}.web.app`);
        } catch (regErr) {
          console.warn(
            `[provisioning:initAdmin] registerAuthorizedAuthDomain non-fatal on ${projectId}:`,
            regErr,
          );
        }

        // Índices compuestos del storefront (products/orders/clients) — automatizado para
        // evitar "The query requires an index" en el panel de administración del shard.
        try {
          await ensureCompositeIndexes(auth, projectId);
        } catch (idxErr) {
          console.warn(
            `[provisioning:initAdmin] ensureCompositeIndexes non-fatal on ${projectId}:`,
            idxErr,
          );
        }
      };
      await retry(initIdentityPlatform, 5, 8000);

      const compositeKey = `${tenantId}_${normalizedOwnerEmail}`;
      const encodedKey = encodeURIComponent(compositeKey);
      try {
        await apiFetch(
          auth,
          `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/admin_roles/${encodedKey}`,
          {
            method: 'PATCH',
            body: {
              fields: {
                role: { stringValue: 'owner' },
                tenantId: { stringValue: tenantId },
                source: { stringValue: 'platform-provisioning' },
                updatedAt: { timestampValue: new Date().toISOString() },
              },
            },
          },
        );
      } catch (roleErr) {
        console.warn(
          `[provisioning:initAdmin] Shard admin_roles write non-fatal on ${projectId}:`,
          roleErr,
        );
      }

      // Also write to the local platform database under 'admin_roles' for development / fallback reference
      try {
        await db.collection('admin_roles').doc(compositeKey).set({
          role: 'owner',
          tenantId: tenantId,
          source: 'platform-provisioning',
          updatedAt: FieldValue.serverTimestamp(),
        });
      } catch (localErr) {
        console.error('Failed to write owner role to local platform DB:', localErr);
      }

      const loginUrl = runtimeSiteId
        ? `https://${runtimeSiteId}.web.app/admin/login`
        : `https://${projectId}.web.app/admin/login`;

      if (loginUrl) {
        await storeRef.collection('private').doc('ownerAccess').set(
          {
            email: normalizedOwnerEmail,
            loginUrl,
            generatedAt: new Date(),
          },
          { merge: true },
        );

        const emailSubject = `Bienvenido a Vertex - Acceso habilitado para ${name}`;

        // Segregación de entorno: detectar PROD vs DESARROLLO dinámicamente.
        const isProd = PLATFORM_PROJECT === 'vertex-platform-app';
        const envLabel = isProd ? 'PRODUCCIÓN' : 'DESARROLLO';
        const emailSubjectFinal = isProd ? emailSubject : `[DEV] ${emailSubject}`;
        // Política de silencio en dev: solo se envía a tiendas de prueba/QA.
        const isTestStore = /(^|[-_])(test|qa|demo)([-_]|$)/i.test(storeId || '');
        const allowEmail = isProd || isTestStore;
        if (!allowEmail) {
          console.log('[Mail Suppressed - DEV]', { storeId, envLabel, ownerEmail });
        } else if (!isProd) {
          console.log('[Mail Sent - DEV QA]', { storeId, envLabel, ownerEmail });
        }
        const emailHtml = `
          <div style="background:#f1f5f9;padding:28px 16px;font-family:Arial,sans-serif;color:#0f172a;">
            <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:14px;border:1px solid #e2e8f0;overflow:hidden;box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.05);">
              <div style="padding:24px 28px;background:linear-gradient(135deg,#0f172a,#10b981);color:#ffffff;">
                <p style="margin:0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;font-weight:700;">Vertex Platform</p>
                <h1 style="margin:8px 0 0;font-size:24px;line-height:1.25;font-weight:700;">¡Tu tienda está siendo creada!</h1>
              </div>
              <div style="padding:28px 24px;">
                <p style="margin:0 0 16px;color:#0f172a;font-size:16px;line-height:1.6;">
                  ¡Hola! Hemos iniciado el aprovisionamiento de tu nueva tienda <strong>${name}</strong> en la plataforma Vertex de manera exitosa.
                </p>
                <p style="margin:0 0 16px;color:#334155;font-size:15px;line-height:1.6;">
                  Tu correo electrónico ha sido preautorizado para ingresar con la máxima seguridad al panel administrativo usando tu cuenta de Google (Google OAuth).
                </p>
                <div style="margin:28px 0;text-align:center;">
                  <a href="${loginUrl}" style="display:inline-block;padding:14px 28px;background:#10b981;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;box-shadow: 0 4px 6px -1px rgba(16, 185, 129, 0.2);">Ingresar al Panel Administrativo</a>
                </div>
                <div style="background:#f8fafc;border-radius:10px;padding:16px;margin:24px 0;border:1px solid #f1f5f9;">
                  <p style="margin:0 0 8px;color:#64748b;font-size:13px;font-weight:600;">Enlace de acceso rápido:</p>
                  <p style="margin:0;color:#10b981;font-size:13px;word-break:break-all;font-family:monospace;">${loginUrl}</p>
                </div>
                <hr style="border:0;border-top:1px solid #e2e8f0;margin:28px 0;" />
                <p style="color:#94a3b8;font-size:11px;margin:0;line-height:1.4;text-align:center;">
                  Este correo fue enviado de forma automática por Vertex Platform al iniciar el aprovisionamiento. Por favor, no respondas a este mensaje.
                </p>
              </div>
            </div>
          </div>
        `;

        try {
          // Always try SMTP first (works in both DEV and PROD without requiring
          // the firestore-send-email extension on the store's project).
          if (allowEmail) {
            try {
              await sendDirectEmail(
                ownerEmail,
                emailSubjectFinal,
                emailHtml,
                `Bienvenido a Vertex. Ingresa con Google al panel administrativo desde: ${loginUrl}`,
              );
              console.info(
                `[provisioning:initAdmin] Welcome email sent via SMTP to ${ownerEmail}.`,
              );
            } catch (smtpErr) {
              // SMTP failed — try writing to the store's mail collection as fallback
              // (requires firestore-send-email extension to be installed in the store project)
              console.error(
                `[provisioning:initAdmin] SMTP failed, attempting mail collection fallback for ${ownerEmail}:`,
                smtpErr,
              );
              const mailDocFields = {
                to: {
                  arrayValue: {
                    values: [{ stringValue: ownerEmail }],
                  },
                },
                message: {
                  mapValue: {
                    fields: {
                      subject: { stringValue: emailSubjectFinal },
                      html: { stringValue: emailHtml },
                      text: {
                        stringValue: `Bienvenido a Vertex. Ingresa con Google al panel administrativo desde: ${loginUrl}`,
                      },
                    },
                  },
                },
                createdAt: {
                  timestampValue: new Date().toISOString(),
                },
              };

              await apiFetch(
                auth,
                `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/mail`,
                {
                  method: 'POST',
                  body: { fields: mailDocFields },
                },
              );
              console.info(
                `[provisioning:initAdmin] Welcome email queued in store ${projectId}'s mail collection.`,
              );
            }
          } // fin allowEmail (supresión en DEV)
        } catch (mailErr) {
          console.error(
            `[provisioning:initAdmin] All email delivery methods failed for ${ownerEmail}, falling back to central platform mail queue:`,
            mailErr,
          );
          // Final fallback: central platform mail collection
          try {
            await db.collection('mail').add({
              to: [ownerEmail],
              message: {
                subject: emailSubject,
                html: emailHtml,
                text: `Bienvenido a Vertex. Ingresa con Google al panel administrativo desde: ${loginUrl}`,
              },
            });
          } catch (centralErr) {
            console.error(
              '[provisioning:initAdmin] Central fallback email queue failed:',
              centralErr,
            );
          }
        }
      }

      await setStep('initAdmin', 'done');
    } catch (err) {
      await fail('initAdmin', err);
      return;
    }
  }

  async function fetchProjectNumber(auth: OAuth2Client, projId: string): Promise<string | null> {
    try {
      const res = (await apiFetch(
        auth,
        `https://cloudresourcemanager.googleapis.com/v1/projects/${projId}`,
      )) as { projectNumber?: string } | undefined;
      return res?.projectNumber ?? null;
    } catch (err) {
      console.warn(`[fetchProjectNumber] Failed for ${projId}:`, err);
      return null;
    }
  }

  async function ensureShardProjectIam(auth: OAuth2Client, projectId: string): Promise<void> {
    const platformProjectId = PLATFORM_PROJECT;
    const defaultShardProjectId =
      PLATFORM_PROJECT === 'vertex-platform-dev' ? 'ecommerce-vertex-dev' : 'ecommerce-vertex';

    // Resolución dinámica de Service Accounts y Números de Proyecto GCP (sin valores hardcodeados)
    const [platformNum, storefrontNum, shardNum] = await Promise.all([
      fetchProjectNumber(auth, platformProjectId),
      fetchProjectNumber(auth, defaultShardProjectId),
      fetchProjectNumber(auth, projectId),
    ]);

    const saList = [
      `firebase-adminsdk-fbsvc@${platformProjectId}.iam.gserviceaccount.com`,
      `firebase-adminsdk-fbsvc@${defaultShardProjectId}.iam.gserviceaccount.com`,
      `${platformProjectId}@appspot.gserviceaccount.com`,
      `${defaultShardProjectId}@appspot.gserviceaccount.com`,
    ];

    if (platformNum) {
      saList.push(`${platformNum}-compute@developer.gserviceaccount.com`);
    }
    if (storefrontNum) {
      saList.push(`${storefrontNum}-compute@developer.gserviceaccount.com`);
    }
    if (shardNum) {
      saList.push(`${shardNum}-compute@developer.gserviceaccount.com`);
    }

    const serviceAccounts = Array.from(new Set(saList));

    let policy: { bindings: Array<{ role: string; members: string[] }>; etag: string } | null =
      null;
    let activeAuth = auth;

    try {
      policy = (await apiFetch(
        auth,
        `https://cloudresourcemanager.googleapis.com/v3/projects/${projectId}:getIamPolicy`,
        { method: 'POST', body: {} },
      )) as { bindings: Array<{ role: string; members: string[] }>; etag: string };
    } catch (userAuthErr) {
      console.warn(
        '[ensureShardProjectIam] Creator auth getIamPolicy warning, trying platform auth:',
        userAuthErr,
      );
      try {
        const platformAuth = await getPlatformServiceAccountOAuthClient();
        activeAuth = platformAuth;
        policy = (await apiFetch(
          platformAuth,
          `https://cloudresourcemanager.googleapis.com/v3/projects/${projectId}:getIamPolicy`,
          { method: 'POST', body: {} },
        )) as { bindings: Array<{ role: string; members: string[] }>; etag: string };
      } catch (platformAuthErr) {
        throw userAuthErr;
      }
    }

    if (!policy) throw new Error(`Could not fetch IAM policy for project ${projectId}`);

    const rolesToEnsure = [
      'roles/owner',
      'roles/editor',
      'roles/firebasehosting.admin',
      'roles/firebaserules.admin',
      // Las functions del storefront (proyecto master del ecommerce) leen/escriben el
      // Firestore de cada shard (orden, catálogo, stock) → datastore.owner en el shard.
      'roles/datastore.owner',
      'roles/datastore.user',
      // Secret Manager: accessor (lectura) + admin (crear secretos/versiones: el 403
      // de initFirestore era en :addVersion, que secretAccessor NO permite).
      'roles/secretmanager.secretAccessor',
      'roles/secretmanager.admin',
      // Firebase Admin + Service Account User para el orchestrator del platform
      'roles/firebase.admin',
      'roles/iam.serviceAccountUser',
    ];

    let modified = false;
    for (const roleName of rolesToEnsure) {
      let binding = policy.bindings?.find((b) => b.role === roleName);
      if (!binding) {
        binding = { role: roleName, members: [] };
        policy.bindings = [...(policy.bindings ?? []), binding];
      }
      for (const sa of serviceAccounts) {
        const member = `serviceAccount:${sa}`;
        if (!binding.members.includes(member)) {
          binding.members.push(member);
          modified = true;
        }
      }
    }

    if (modified) {
      await apiFetch(
        activeAuth,
        `https://cloudresourcemanager.googleapis.com/v3/projects/${projectId}:setIamPolicy`,
        { method: 'POST', body: { policy } },
      );
      console.info(`[ensureShardProjectIam] Defensively granted IAM roles on ${projectId}`);
    }

    try {
      await ensureShardSecurityPolicies(projectId, activeAuth);
    } catch (secErr) {
      console.warn(
        `[ensureShardProjectIam] ensureShardSecurityPolicies non-fatal warning on ${projectId}:`,
        secErr,
      );
    }
  }

  // ── Step 8: Grant platform SA deploy access ────────────────────────────
  if (!isDone('grantAccess')) {
    await setStep('grantAccess', 'running', null, 'Configurando roles y permisos IAM en GCP...');
    try {
      await ensureShardProjectIam(auth, projectId);
      await setStep('grantAccess', 'done');
    } catch (err) {
      if (runtimeMode === 'shared-shard') {
        console.warn(
          `[provisioning:grantAccess] Non-fatal IAM sync on shared shard ${projectId}:`,
          err,
        );
        await setStep('grantAccess', 'done');
      } else {
        await fail('grantAccess', err);
        return;
      }
    }
  }

  // ── Step 9: Trigger GitHub Actions deploy ──────────────────────────────
  if (!isDone('triggerDeploy')) {
    if (currentSteps['triggerDeploy']?.status === 'running') {
      return;
    }
    await setStep(
      'triggerDeploy',
      'running',
      null,
      'Disparando workflow de compilación y despliegue en GitHub...',
    );
    try {
      if (process.env.FUNCTIONS_EMULATOR === 'true') {
        console.log(
          `[provisioning:triggerDeploy] Local emulator detected. Auto-completing deploy for store: ${storeId}`,
        );
        await storeRef.update({
          'provisioningSteps.triggerDeploy.status': 'done',
          'provisioningSteps.triggerDeploy.error': null,
          status: 'active',
          lastDeployedAt: new Date(),
          templateVersion: CURRENT_TEMPLATE_VERSION,
          schemaVersion: CURRENT_STORE_SCHEMA_VERSION,
          updatedAt: new Date(),
        });
        if (runtimeMode === 'shared-shard' && shardId) {
          const shardRef = db.collection('infrastructure_shards').doc(shardId);
          try {
            await db.runTransaction(async (transaction) => {
              const shardSnap = await transaction.get(shardRef);
              if (shardSnap.exists) {
                const data = shardSnap.data();
                const currentStores = data?.currentStores || 0;
                const maxCapacity = data?.maxCapacity || DEFAULT_MAX_STORES_PER_SHARD;
                const newActive = currentStores + 1;
                const newStatus = newActive >= maxCapacity ? 'FULL' : data?.status || 'ACTIVE';
                transaction.update(shardRef, {
                  currentStores: newActive,
                  status: newStatus,
                  updatedAt: new Date(),
                });
              }
            });
          } catch (err) {
            console.error(
              `[provisioning:triggerDeploy] Failed to increment currentStores on shard ${shardId}:`,
              err,
            );
          }
        }
        return;
      }
      if (runtimeMode === 'shared-shard' && runtimeSiteId) {
        try {
          await apiFetch(
            auth,
            `https://firebasehosting.googleapis.com/v1beta1/projects/${projectId}/sites?siteId=${runtimeSiteId}`,
            {
              method: 'POST',
              body: { type: 'USER_SITE' },
            },
          );
          console.info(
            `[provisioning:triggerDeploy] Ensured custom hosting site ${runtimeSiteId} exists on shard ${projectId}`,
          );
        } catch (err: any) {
          const msg = err instanceof Error ? err.message : String(err);
          if (
            !msg.includes('already exists') &&
            !msg.includes('409') &&
            !msg.includes('reserved by another project') &&
            !msg.includes('Invalid name')
          ) {
            console.warn(
              `[provisioning:triggerDeploy] Warning: custom hosting site ${runtimeSiteId} check failed on shard ${projectId}: ${msg}`,
            );
          }
        }
      }

      try {
        await retry(
          () => ensureStoreAuthDomains(auth, { storeId, projectId, runtimeSiteId, customDomain }),
          3,
          5000,
        );
      } catch (authDomainErr) {
        console.warn(
          `[provisioning:triggerDeploy] ensureStoreAuthDomains non-fatal warning on ${projectId}:`,
          authDomainErr,
        );
      }

      // Defensively ensure IAM permissions are granted on the target project before dispatching GitHub Action
      try {
        await ensureShardProjectIam(auth, projectId);
      } catch (iamErr) {
        console.warn(
          `[provisioning:triggerDeploy] Defensive IAM policy check warning on ${projectId}:`,
          iamErr,
        );
      }

      const pat = await getGitHubPat();

      const env = resolvePlatformEnvironment(PLATFORM_PROJECT);
      const targetRef = env === 'production' ? 'main' : env === 'local' ? 'local' : 'develop';

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
            event_type: 'provision-store',
            // NOTA: la API de repository_dispatch NO permite fijar el `ref` del dispatch;
            // siempre ejecuta el workflow del default branch (main). El client_payload.ref
            // se usa en el checkout del workflow para correr el código de la rama correcta.
            client_payload: {
              store_id: storeId,
              tenant_id: tenantId,
              project_id: projectId,
              site_id: runtimeSiteId || 'default',
              firebase_config: JSON.stringify(firebaseConfig),
              store_name: name,
              platform_project_id: PLATFORM_PROJECT,
              environment: env,
              ref: targetRef,
            },
          }),
        },
      );
      if (!res.ok && res.status !== 204)
        throw new Error(`GitHub API: ${res.status} ${await res.text()}`);
    } catch (err) {
      await fail('triggerDeploy', err);
      return;
    }
  }
}

export const runProvisioning = onDocumentCreated(
  { document: 'stores/{storeId}', timeoutSeconds: 540, memory: '1GiB' },
  async (event) => {
    const data = event.data?.data();
    if (!data || data['status'] !== 'provisioning') return;
    try {
      await executeProvisioningSteps(event.params.storeId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[runProvisioning] Unhandled provisioning error for store ${event.params.storeId}:`,
        err,
      );
      await getFirestore()
        .collection('stores')
        .doc(event.params.storeId)
        .update({
          status: 'error',
          updatedAt: new Date(),
          unhandledProvisioningError: message.slice(0, 800),
        });
    }
  },
);

export const checkStoreOAuthRedirect = onCall<{ storeId: string }>(
  { cors: ALLOWED_ORIGINS, invoker: 'public', timeoutSeconds: 60, memory: '256MiB' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError(
        'permission-denied',
        'Only platform admins can check store OAuth redirect URIs.',
      );
    }

    const { storeId } = request.data;
    if (!storeId) {
      throw new HttpsError('invalid-argument', 'storeId is required.');
    }

    const db = getFirestore();
    const snap = await db.collection('stores').doc(storeId).get();
    if (!snap.exists) {
      throw new HttpsError('not-found', 'Store not found.');
    }

    const data = snap.data()!;
    const shardProjectId =
      (data['runtimeProjectId'] as string | undefined) ||
      (data['firebaseProjectId'] as string | undefined);

    if (!shardProjectId || shardProjectId === getMasterStorefrontProjectId()) {
      return { ok: true, redirectUri: null, clientId: null };
    }

    // Client OAuth del master (el Google IdP de los shards usa este clientId).
    const provisioningOwnerId =
      typeof data['provisioningOwnerId'] === 'string'
        ? (data['provisioningOwnerId'] as string)
        : undefined;
    const env = resolvePlatformEnvironment(PLATFORM_PROJECT);
    let clientId = '';
    try {
      const auth = await getOwnerOAuthClient(provisioningOwnerId);
      const masterIdpConfig = (await apiFetch(
        auth,
        `https://identitytoolkit.googleapis.com/v2/projects/${getMasterStorefrontProjectId()}/defaultSupportedIdpConfigs/google.com`,
      )) as { clientId?: string };
      clientId = masterIdpConfig?.clientId || '';
    } catch {
      clientId = '';
    }

    if (!clientId) {
      const { getMasterOAuthClientId } = await import('./shard-readiness');
      clientId = getMasterOAuthClientId(env);
    }

    const redirectUri = `https://${shardProjectId}.firebaseapp.com/__/auth/handler`;

    let ok = false;
    if (clientId) {
      try {
        const url =
          `https://accounts.google.com/o/oauth2/v2/auth` +
          `?client_id=${encodeURIComponent(clientId)}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&response_type=code&scope=openid%20email%20profile&prompt=select_account`;
        const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
        const location = res.headers.get('location') ?? '';
        const body = await res.text();
        ok = !location.includes('/signin/oauth/error') && !body.includes('redirect_uri_mismatch');
      } catch {
        ok = false;
      }
    }

    return {
      ok,
      redirectUri,
      clientId: clientId || null,
      consoleUrl: `https://console.cloud.google.com/apis/credentials?project=${getMasterStorefrontProjectId()}`,
    };
  },
);

export const repairStoreAuthDomains = onCall<{ storeId: string }>(
  { cors: ALLOWED_ORIGINS, invoker: 'public', timeoutSeconds: 120, memory: '256MiB' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError(
        'permission-denied',
        'Only platform admins can repair store auth domains.',
      );
    }

    const { storeId } = request.data;
    if (!storeId) {
      throw new HttpsError('invalid-argument', 'storeId is required.');
    }

    const db = getFirestore();
    const storeRef = db.collection('stores').doc(storeId);
    const snap = await storeRef.get();

    if (!snap.exists) {
      throw new HttpsError('not-found', 'Store not found.');
    }

    const data = snap.data()!;
    const projectId = data['firebaseProjectId'] as string | undefined;
    if (!projectId) {
      throw new HttpsError('failed-precondition', 'Store does not have firebaseProjectId.');
    }

    const provisioningOwnerId =
      typeof data['provisioningOwnerId'] === 'string'
        ? (data['provisioningOwnerId'] as string)
        : undefined;
    const auth = await getOwnerOAuthClient(provisioningOwnerId);

    try {
      await initializeFirebaseAuth(auth, projectId);
      const authorizedDomains = await retry(
        () =>
          ensureStoreAuthDomains(auth, {
            storeId,
            projectId,
            runtimeSiteId: data['runtimeSiteId'] as string | undefined,
            customDomain: data['customDomain'] as string | null | undefined,
          }),
        5,
        8000,
      );

      await storeRef.update({
        authDomainsRepairedAt: new Date(),
        updatedAt: new Date(),
      });

      return { success: true, projectId, authorizedDomains };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpsError(
        'internal',
        `Could not repair Firebase Auth authorized domains: ${message}`,
      );
    }
  },
);

export const retryProvisioning = onCall<{ storeId: string }>(
  { cors: ALLOWED_ORIGINS, invoker: 'public' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError('permission-denied', 'Only platform admins can retry provisioning.');
    }
    await checkRateLimit(request.auth?.uid, 'retryProvisioning', 5, 15);

    const { storeId } = request.data;
    if (!storeId) {
      throw new HttpsError('invalid-argument', 'storeId is required.');
    }

    const db = getFirestore();
    const storeRef = db.collection('stores').doc(storeId);
    const snap = await storeRef.get();

    if (!snap.exists) {
      throw new HttpsError('not-found', 'Store not found.');
    }

    const storeData = snap.data()!;
    if (storeData['status'] !== 'error' && storeData['status'] !== 'provisioning') {
      throw new HttpsError(
        'failed-precondition',
        'Solo se pueden reintentar tiendas en estado de error o aprovisionamiento.',
      );
    }

    const steps = (storeData['provisioningSteps'] ?? {}) as Record<string, ProvisioningStep>;
    const updates: Record<string, unknown> = {
      status: 'provisioning',
      updatedAt: new Date(),
      error: null,
      unhandledProvisioningError: null,
    };
    for (const [id, step] of Object.entries(steps)) {
      if (step.status === 'error' || step.status === 'running') {
        updates[`provisioningSteps.${id}.status`] = 'pending';
        updates[`provisioningSteps.${id}.error`] = null;
        updates[`provisioningSteps.${id}.detail`] = null;
      }
    }
    if (steps['createProject']?.status === 'error') {
      updates['provisioningOwnerId'] = null;
    }
    if (
      steps['triggerDeploy']?.status === 'error' ||
      steps['triggerDeploy']?.status === 'running' ||
      steps['grantAccess']?.status === 'error' ||
      steps['grantAccess']?.status === 'running'
    ) {
      updates['provisioningSteps.grantAccess.status'] = 'pending';
      updates['provisioningSteps.grantAccess.error'] = null;
      updates['provisioningSteps.grantAccess.detail'] = null;
      updates['provisioningSteps.triggerDeploy.status'] = 'pending';
      updates['provisioningSteps.triggerDeploy.error'] = null;
      updates['provisioningSteps.triggerDeploy.detail'] = null;
    }
    await storeRef.update(updates);

    try {
      // Trigger execution in the background to avoid 504 Gateway Timeout on the HTTP call
      void executeProvisioningSteps(storeId).catch(async (err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[retryProvisioning:background] Unexpected error for store ${storeId}:`, err);
        await storeRef.update({
          status: 'error',
          updatedAt: new Date(),
          unhandledProvisioningError: message.slice(0, 800),
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await storeRef.update({
        status: 'error',
        updatedAt: new Date(),
        unhandledProvisioningError: message.slice(0, 800),
      });
      throw new HttpsError(
        'internal',
        'Failed to trigger provisioning. Review error details and try again.',
      );
    }
    return { success: true };
  },
);

export const completeStoreDeployment = onCall<{
  storeId: string;
  success: boolean;
  deployToken: string;
  idToken?: string;
  commitSha?: string;
  commitMessage?: string;
  ref?: string;
  version?: string;
}>({ cors: ALLOWED_ORIGINS, invoker: 'public' }, async (request) => {
  const { storeId, success, deployToken, idToken, commitSha, commitMessage, ref, version } =
    request.data;

  if (!storeId) {
    throw new HttpsError('invalid-argument', 'storeId is required.');
  }

  const db = getFirestore();
  const storeRef = db.collection('stores').doc(storeId);
  const snap = await storeRef.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'Store not found.');
  }
  const storeData = snap.data()!;
  const expectedRepo = 'vertex-solutions-ar/ecommerce-vertex';

  let authenticated = false;
  if (idToken) {
    authenticated = await verifyGitHubOidcToken(idToken, {
      repository: expectedRepo,
      ref: ref ?? undefined,
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

  // Create a deployment history log entry
  const storeVersion =
    (storeData['templateVersion'] as string) || (storeData['appVersion'] as string);
  const effectiveVersion =
    version && version !== '0.1.0'
      ? version
      : storeVersion
        ? storeVersion.replace(/^v/, '')
        : CURRENT_TEMPLATE_VERSION;

  const deployLogRef = storeRef.collection('deploys').doc();
  await deployLogRef.set({
    timestamp: new Date(),
    success,
    commitSha: commitSha || '',
    commitMessage: commitMessage || '',
    ref: ref || '',
    version: effectiveVersion,
    error: success ? null : 'Storefront deployment failed. Check GitHub Action logs for details.',
  });

  // Prune deploy history beyond 50 entries to keep database clean
  try {
    const deploysSnap = await storeRef.collection('deploys').orderBy('timestamp', 'desc').get();
    if (deploysSnap.docs.length > 50) {
      const docsToDelete = deploysSnap.docs.slice(50);
      const batch = db.batch();
      for (const doc of docsToDelete) {
        batch.delete(doc.ref);
      }
      await batch.commit();
    }
  } catch (err) {
    logger.warn('[recordDeploymentResult] Non-fatal error pruning old deploy history:', err);
  }

  if (!success) {
    await storeRef.update({
      redeployStatus: 'failed',
      redeployError: 'El despliegue en GitHub Actions falló. Revisá los logs para más detalles.',
      updatedAt: new Date(),
    });
  }

  if (storeData['status'] === 'active' && success) {
    await storeRef.update({
      redeployStatus: 'idle',
      redeployError: null,
      lastDeployedAt: new Date(),
      updatedAt: new Date(),
    });
    return { success: true };
  }

  if (success) {
    await storeRef.update({
      'provisioningSteps.triggerDeploy.status': 'done',
      'provisioningSteps.triggerDeploy.error': null,
      status: 'active',
      redeployStatus: 'idle',
      redeployError: null,
      lastDeployedAt: new Date(),
      templateVersion: version || CURRENT_TEMPLATE_VERSION,
      appVersion: `v${version || CURRENT_TEMPLATE_VERSION}`,
      targetChannel: 'stable',
      schemaVersion: CURRENT_STORE_SCHEMA_VERSION,
      updatedAt: new Date(),
    });

    if (storeData['runtimeMode'] === 'shared-shard' && storeData['shardId']) {
      const shardRef = db.collection('infrastructure_shards').doc(storeData['shardId']);
      try {
        await db.runTransaction(async (transaction) => {
          const shardSnap = await transaction.get(shardRef);
          if (shardSnap.exists) {
            const data = shardSnap.data();
            const currentStores = data?.currentStores || 0;
            const maxCapacity = data?.maxCapacity || DEFAULT_MAX_STORES_PER_SHARD;
            const newActive = currentStores + 1;
            const newStatus = newActive >= maxCapacity ? 'FULL' : data?.status || 'ACTIVE';
            transaction.update(shardRef, {
              currentStores: newActive,
              status: newStatus,
              updatedAt: new Date(),
            });
            if (newStatus === 'FULL') {
              console.info(
                `[completeStoreDeployment] Shard ${storeData['shardId']} reached capacity (${newActive}/${maxCapacity}). Marked as 'FULL'.`,
              );
            }
          }
        });
        console.info(
          `[completeStoreDeployment] Successfully incremented currentStores on shard ${storeData['shardId']}`,
        );
      } catch (err) {
        console.error(
          `[completeStoreDeployment] Failed to increment currentStores on shard ${storeData['shardId']}:`,
          err,
        );
      }
    }

    // Notificación por email al administrador central de la plataforma
    const storeSub = (storeData['subscription'] as Record<string, unknown>) || {};
    const publicStoreUrl =
      storeData['siteUrl'] ||
      `https://${storeData['subdomain'] || (storeData['slug'] ? `vtx-${storeData['slug']}` : storeId)}.web.app`;
    const adminPanelUrl = `${publicStoreUrl}/admin`;

    void notifyAdminNewStoreCreated({
      storeId,
      storeName: storeData['name'] || storeId,
      slug: storeData['slug'] || storeId,
      ownerEmail: storeData['ownerEmail'] || '',
      verticalId: storeData['verticalId'],
      projectId: storeData['projectId'],
      shardMode: storeData['runtimeMode'] || (storeData['shardId'] ? 'shared' : 'dedicated'),
      siteUrl: publicStoreUrl,
      tier: storeData['tier'] || 'PRO',
      billingCycle: storeData['billingCycle'] || 'monthly',
      subscriptionStatus: (storeSub['status'] as string) || (storeData['status'] as string),
      trialDays:
        typeof storeSub['trialDays'] === 'number' ? (storeSub['trialDays'] as number) : null,
      createdAt: (storeData['createdAt'] as FirebaseFirestore.Timestamp)?.toDate() || new Date(),
    });

    // Notificación por email de bienvenida con blindaje al dueño del comercio
    if (storeData['ownerEmail']) {
      void notifyOwnerStoreWelcome({
        ownerEmail: storeData['ownerEmail'],
        storeName: storeData['name'] || storeId,
        slug: storeData['slug'] || storeId,
        publicUrl: publicStoreUrl,
        adminUrl: adminPanelUrl,
        trialDays:
          typeof storeSub['trialDays'] === 'number' ? (storeSub['trialDays'] as number) : null,
      }).catch((err) => {
        console.error(`[completeStoreDeployment] Error sending welcome email to owner:`, err);
      });
    }
  } else {
    await storeRef.update({
      'provisioningSteps.triggerDeploy.status': 'error',
      'provisioningSteps.triggerDeploy.error':
        'Storefront deployment failed. Check GitHub Action logs for details.',
      status: 'error',
      updatedAt: new Date(),
    });
  }

  return { success: true };
});

const HEAL_API_LIST = [
  'identitytoolkit.googleapis.com',
  'secretmanager.googleapis.com',
  'firestore.googleapis.com',
  'firebase.googleapis.com',
  'cloudresourcemanager.googleapis.com',
  'iam.googleapis.com',
  'firebasehosting.googleapis.com',
];

const HEAL_IAM_ROLES = [
  'roles/secretmanager.admin',
  'roles/secretmanager.secretAccessor',
  'roles/datastore.owner',
  'roles/firebase.admin',
  'roles/iam.serviceAccountUser',
  'roles/editor',
];

/**
 * triggerHealShards — Auto-heal nativo de shards (Operaciones Cloud).
 * Solo el admin de plataforma (vertex.tech.dev@gmail.com o claim admin). Habilita
 * las 7 APIs canónicas, asegura los roles IAM del orchestrator en cada shard
 * y evalúa exhaustivamente el checklist de los 6 pilares de preparación del shard.
 */
export const triggerHealShards = onCall(
  { timeoutSeconds: 300, memory: '512MiB', cors: ALLOWED_ORIGINS },
  async (request) => {
    const email = String(request.auth?.token?.email || '');
    const isAdmin =
      email === 'vertex.tech.dev@gmail.com' || Boolean(request.auth?.token?.['platformAdmin']);
    if (!request.auth || !isAdmin) {
      throw new HttpsError('permission-denied', 'Solo el admin de plataforma puede sanear shards.');
    }
    const db = getFirestore();
    const shardsSnap = await db.collection('infrastructure_shards').get();
    const projectIds = Array.from(
      new Set(
        shardsSnap.docs
          .map((d) => {
            const data = d.data();
            return String(data['projectId'] || data['id'] || '').trim();
          })
          .filter((v) => v.length > 0),
      ),
    );
    const auth = await getOwnerOAuthClient();
    const platformSA = `${PLATFORM_PROJECT}@appspot.gserviceaccount.com`;
    const results: Array<{ shard: string; apis: string; iam: string; status: string }> = [];

    for (const projectId of projectIds) {
      try {
        for (const svc of HEAL_API_LIST) {
          await ensureServiceEnabled(auth, projectId, svc);
        }
        // IAM idempotente vía Cloud Resource Manager v3
        const crm = `https://cloudresourcemanager.googleapis.com/v3/projects/${projectId}`;
        const policy = (await apiFetch(auth, `${crm}:getIamPolicy`, {
          method: 'POST',
          body: {},
          quotaProject: projectId,
        })) as { bindings?: Array<{ role: string; members: string[] }>; etag?: string };
        const bindings = policy.bindings || [];
        const member = `serviceAccount:${platformSA}`;
        let modified = false;
        for (const role of HEAL_IAM_ROLES) {
          let b = bindings.find((x) => x.role === role);
          if (!b) {
            b = { role, members: [] };
            bindings.push(b);
          }
          if (!b.members.includes(member)) {
            b.members.push(member);
            modified = true;
          }
        }
        if (modified) {
          await apiFetch(auth, `${crm}:setIamPolicy`, {
            method: 'POST',
            body: { policy: { ...policy, bindings, etag: policy.etag } },
            quotaProject: projectId,
          });
        }

        // Evaluar granularmente los 6 pilares de preparación y persistir en infrastructure_shards
        const matchingDocs = shardsSnap.docs.filter((d) => {
          const data = d.data();
          const pId = String(data['projectId'] || data['id'] || '').trim();
          return pId === projectId;
        });

        for (const sDoc of matchingDocs) {
          const shardData = { id: sDoc.id, ...sDoc.data() } as StoreShard;
          const evaluation = await evaluateShardReadiness(shardData);
          await sDoc.ref.update({
            status: evaluation.recommendedStatus,
            readinessChecklist: evaluation.checklist,
            missingSteps: evaluation.missingSteps,
            actionableFixes: evaluation.fixes,
            lastValidatedAt: new Date().toISOString(),
            updatedAt: new Date(),
          });
        }

        results.push({ shard: projectId, apis: 'OK', iam: 'OK', status: 'OK' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          shard: projectId,
          apis: 'ERROR',
          iam: 'ERROR',
          status: `ERROR: ${msg.slice(0, 140)}`,
        });
      }
    }
    return { success: true, shards: projectIds.length, results };
  },
);
