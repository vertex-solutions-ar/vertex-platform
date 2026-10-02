import { getFirestore } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import {
  ALLOWED_ORIGINS,
  PLATFORM_PROJECT,
  getOwnerOAuthClient,
  getGitHubPat,
  getDeployToken,
  apiFetch,
  retry,
  listProvisioningOwnerCandidates,
  sendDirectEmail,
} from './helpers';
import {
  resolvePlatformEnvironment,
  summarizeShardCapacity,
  DEFAULT_MAX_STORES_PER_SHARD,
} from './runtime';
import { verifyGitHubOidcToken } from './github-oidc';
import type {
  InviteStaffPayload,
  StoreRuntimeMode,
  StoreShard,
  UpdateStoreConfigPayload,
} from './types';

function resolveRuntimeProjectId(store: {
  runtimeProjectId?: string;
  firebaseProjectId?: string;
}): string {
  const projectId = store.runtimeProjectId ?? store.firebaseProjectId;
  if (!projectId) {
    throw new HttpsError('failed-precondition', 'Store runtime project is not configured.');
  }
  return projectId;
}

function resolveRuntimeSiteId(store: { runtimeSiteId?: string }): string {
  return store.runtimeSiteId ?? 'default';
}

function isOwnerOrSuperAdmin(
  authEmail: string | undefined,
  ownerEmail: string | undefined,
): boolean {
  if (!authEmail) return false;
  // Super-admin emails — configurable via PROTECTED_SUPER_ADMINS env var
  const superAdmins = (
    process.env.PROTECTED_SUPER_ADMINS ||
    'juan.l.espeche@gmail.com,leivalihue@gmail.com,vertex.tech.dev@gmail.com'
  )
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  return superAdmins.includes(authEmail) || authEmail === ownerEmail;
}

export async function logAuditAction(
  userId: string,
  email: string | undefined,
  action: string,
  targetId: string,
  result: 'success' | 'failure',
  details?: Record<string, any>,
): Promise<void> {
  try {
    const db = getFirestore();
    await db.collection('auditLog').add({
      userId,
      email: email || null,
      action,
      targetId,
      timestamp: new Date(),
      result,
      details: details || null,
    });
  } catch (err) {
    console.error('[logAuditAction] Failed to write audit log:', err);
  }
}

export async function checkRateLimit(
  uid: string | undefined,
  action: string,
  maxCalls: number,
  windowMinutes: number,
): Promise<void> {
  if (process.env.FUNCTIONS_EMULATOR === 'true') return;
  if (!uid) return;
  const db = getFirestore();
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowMinutes * 60 * 1000);

  const snap = await db
    .collection('auditLog')
    .where('userId', '==', uid)
    .where('action', '==', action)
    .where('timestamp', '>', cutoff)
    .get();

  if (snap.size >= maxCalls) {
    throw new HttpsError(
      'resource-exhausted',
      `Límite de solicitudes excedido para la acción: ${action}. Por favor, intentá de nuevo más tarde.`,
    );
  }
}

function inferProjectIdFromDefaultUrl(defaultUrl?: string): string | null {
  const raw = (defaultUrl ?? '').trim();
  if (!raw) {
    return null;
  }

  try {
    const url = new URL(raw);
    const host = (url.hostname || '').toLowerCase();
    const webAppSuffix = '.web.app';
    if (!host.endsWith(webAppSuffix)) {
      return null;
    }

    const projectId = host.slice(0, -webAppSuffix.length).trim();
    return projectId || null;
  } catch {
    return null;
  }
}

async function deleteHostingSite(
  auth: Awaited<ReturnType<typeof getOwnerOAuthClient>>,
  projectId: string,
  siteId: string,
): Promise<void> {
  const tokenRes = await auth.getAccessToken();
  const headers = {
    Authorization: `Bearer ${tokenRes.token}`,
    'Content-Type': 'application/json',
    'x-goog-user-project': PLATFORM_PROJECT,
  };

  const domainsRes = await fetch(
    `https://firebasehosting.googleapis.com/v1beta1/projects/${projectId}/sites/${siteId}/domains`,
    { method: 'GET', headers },
  );

  if (domainsRes.ok) {
    const domainsData = (await domainsRes.json()) as { domains?: Array<{ domainName?: string }> };
    const domains = (domainsData.domains ?? [])
      .map((domain) => domain.domainName?.trim())
      .filter((domain): domain is string => !!domain);

    for (const domainName of domains) {
      if (domainName.endsWith('.web.app') || domainName.endsWith('.firebaseapp.com')) {
        continue;
      }

      const deleteDomainRes = await fetch(
        `https://firebasehosting.googleapis.com/v1beta1/projects/${projectId}/sites/${siteId}/domains/${encodeURIComponent(domainName)}`,
        { method: 'DELETE', headers },
      );

      if (!deleteDomainRes.ok && deleteDomainRes.status !== 404) {
        const body = await deleteDomainRes.text();
        throw new Error(
          `[deleteStore] Failed deleting custom domain ${domainName} from ${projectId}/${siteId}: ${deleteDomainRes.status} ${body}`,
        );
      }
    }
  } else if (domainsRes.status !== 404 && domainsRes.status !== 403) {
    const body = await domainsRes.text();
    throw new Error(
      `[deleteStore] Failed listing Hosting domains for ${projectId}/${siteId}: ${domainsRes.status} ${body}`,
    );
  } else if (domainsRes.status === 403) {
    // Some owners can delete a site but cannot list domains on it.
    console.warn(
      `[deleteStore] Skipping domain cleanup for ${projectId}/${siteId} due to 403 on domain listing.`,
    );
  }

  if (siteId === projectId || siteId === 'default') {
    console.log(
      `[deleteStore] Site ${siteId} is the default site for project ${projectId}. Skipping site resource deletion call to avoid Firebase error. Custom domains have been successfully cleaned up.`,
    );
    return;
  }

  const deleteSiteRes = await fetch(
    `https://firebasehosting.googleapis.com/v1beta1/projects/${projectId}/sites/${siteId}`,
    { method: 'DELETE', headers },
  );

  if (!deleteSiteRes.ok && deleteSiteRes.status !== 404) {
    const body = await deleteSiteRes.text();
    throw new Error(
      `[deleteStore] Failed deleting Hosting site ${projectId}/${siteId}: ${deleteSiteRes.status} ${body}`,
    );
  }
}

async function deployHostingTombstone(
  auth: Awaited<ReturnType<typeof getOwnerOAuthClient>>,
  projectId: string,
  siteId: string,
): Promise<void> {
  const tokenRes = await auth.getAccessToken();
  const headers = {
    Authorization: `Bearer ${tokenRes.token}`,
    'Content-Type': 'application/json',
    'x-goog-user-project': PLATFORM_PROJECT,
  };

  const createVersionRes = await fetch(
    `https://firebasehosting.googleapis.com/v1beta1/projects/${projectId}/sites/${siteId}/versions`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        status: 'CREATED',
        config: {},
      }),
    },
  );

  if (!createVersionRes.ok) {
    const body = await createVersionRes.text();
    throw new Error(
      `[runtimeCleanup] Failed creating tombstone version for ${projectId}/${siteId}: ${createVersionRes.status} ${body}`,
    );
  }

  const createVersionData = (await createVersionRes.json()) as { name?: string };
  const versionName = (createVersionData.name || '').trim();
  if (!versionName) {
    throw new Error(
      `[runtimeCleanup] Missing version name when creating tombstone for ${projectId}/${siteId}.`,
    );
  }

  const populateRes = await fetch(
    `https://firebasehosting.googleapis.com/v1beta1/${versionName}:populate`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ files: {} }),
    },
  );

  if (!populateRes.ok) {
    const body = await populateRes.text();
    throw new Error(
      `[runtimeCleanup] Failed populating tombstone version for ${projectId}/${siteId}: ${populateRes.status} ${body}`,
    );
  }

  const releaseRes = await fetch(
    `https://firebasehosting.googleapis.com/v1beta1/projects/${projectId}/sites/${siteId}/releases?versionName=${encodeURIComponent(versionName)}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'runtime-cleanup-tombstone' }),
    },
  );

  if (!releaseRes.ok) {
    const body = await releaseRes.text();
    throw new Error(
      `[runtimeCleanup] Failed releasing tombstone version for ${projectId}/${siteId}: ${releaseRes.status} ${body}`,
    );
  }
}

/**
 * Proyectos GCP creados ad-hoc por la plataforma (shards nuevos `vtx-sd-*` y
 * tiendas dedicadas `vtx-<slug>`). Son desechables: pueden eliminarse cuando
 * quedan vacíos. Los proyectos master (ecommerce-vertex-dev, ecommerce-vertex)
 * NO cumplen este patrón y nunca se eliminan.
 */
function isDisposableProject(projectId: string): boolean {
  return /^vtx-sd-/.test(projectId) || /^vtx-/.test(projectId);
}

async function deleteProjectAndWait(
  auth: Awaited<ReturnType<typeof getOwnerOAuthClient>>,
  projectId: string,
): Promise<void> {
  const deletion = (await apiFetch(
    auth,
    `https://cloudresourcemanager.googleapis.com/v3/projects/${projectId}`,
    { method: 'DELETE' },
  )) as { name?: string; done?: boolean; error?: { message?: string } };

  if (!deletion.name) {
    return;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const operation = (await apiFetch(
      auth,
      `https://cloudresourcemanager.googleapis.com/v3/${deletion.name}`,
      { method: 'GET' },
    )) as { done?: boolean; error?: { message?: string } };

    if (operation.done) {
      if (operation.error?.message) {
        throw new Error(
          `[deleteStore] Project deletion failed for ${projectId}: ${operation.error.message}`,
        );
      }
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  throw new Error(`[deleteStore] Project deletion operation timed out for ${projectId}`);
}

function isProjectAlreadyDeletedOrInactiveError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('project not active') ||
    msg.includes('not found') ||
    msg.includes('404') ||
    msg.includes('failed_precondition')
  );
}

function isHostingAlreadyGoneOrInactiveError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('not found') || msg.includes('404') || msg.includes('site not found');
}

function getCandidateSiteIds(runtimeSiteId: string, projectId: string): string[] {
  const candidates = [runtimeSiteId, projectId, 'default']
    .map((value) => (value || '').trim())
    .filter((value) => value.length > 0);
  return Array.from(new Set(candidates));
}

async function withAnyProvisioningOwner<T>(
  db: ReturnType<typeof getFirestore>,
  preferredOwnerId: string | undefined,
  operation: (auth: Awaited<ReturnType<typeof getOwnerOAuthClient>>, ownerId: string) => Promise<T>,
): Promise<T> {
  const owners = await listProvisioningOwnerCandidates(db, preferredOwnerId);
  let lastErr: unknown = null;

  for (const owner of owners) {
    try {
      const ownerAuth = await getOwnerOAuthClient(owner.id);
      return await operation(ownerAuth, owner.id);
    } catch (err) {
      lastErr = err;
      console.error(`[runtimeCleanup] owner ${owner.id} failed:`, err);
    }
  }

  throw lastErr ?? new Error('No provisioning owner could execute runtime cleanup operation.');
}

async function enqueueRuntimeCleanupTask(
  db: ReturnType<typeof getFirestore>,
  payload: {
    storeId?: string;
    preferredOwnerId?: string;
    projectIds: string[];
    siteId: string;
    runtimeMode: StoreRuntimeMode;
    deleteProject?: boolean;
    reason: string;
  },
): Promise<void> {
  await db.collection('runtimeCleanupTasks').add({
    storeId: payload.storeId ?? null,
    preferredOwnerId: payload.preferredOwnerId ?? null,
    projectIds: payload.projectIds,
    siteId: payload.siteId,
    runtimeMode: payload.runtimeMode,
    deleteProject: payload.deleteProject ?? false,
    reason: payload.reason,
    status: 'pending',
    attempts: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

export const getRuntimeCapacitySummary = onCall(
  { cors: ALLOWED_ORIGINS, invoker: 'public' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError(
        'permission-denied',
        'Only platform admins can inspect runtime capacity.',
      );
    }

    const db = getFirestore();
    const environment = resolvePlatformEnvironment();

    // 1. Fetch shards and extract unique projects
    const shardsSnap = await db
      .collection('infrastructure_shards')
      .where('environment', '==', environment)
      .get();
    const shards = shardsSnap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }) as StoreShard)
      .filter((shard) => shard.runtimeMode === 'shared-shard');
    const shardProjectIds = new Set(shards.map((s) => s.projectId).filter(Boolean));

    // 2. Fetch dedicated project stores and extract unique projects
    const storesSnap = await db
      .collection('stores')
      .where('runtimeMode', '==', 'dedicated-project')
      .where('status', '==', 'active')
      .get();
    const dedicatedProjectIds = new Set(
      storesSnap.docs.map((doc) => doc.data()['projectId']).filter(Boolean),
    );

    // 3. Count total unique active projects
    const totalActiveProjects = new Set([...shardProjectIds, ...dedicatedProjectIds]).size;

    // 4. Fetch billing accounts total limit
    const [newBillingSnap, oldBillingSnap] = await Promise.all([
      db.collection('billing_accounts').where('active', '==', true).get(),
      db.collection('billingAccounts').where('active', '==', true).get(),
    ]);
    const bSnap = !newBillingSnap.empty ? newBillingSnap : oldBillingSnap;
    let maxProjectsLimit = 0;
    bSnap.docs.forEach((d) => {
      const data = d.data();
      maxProjectsLimit +=
        (data['gcpProjectLimit'] as number) || (data['maxProjects'] as number) || 5;
    });
    if (maxProjectsLimit === 0) maxProjectsLimit = 20;

    // 5. Calculate usage metrics and check warning threshold (80%)
    const projectUsageRatio = maxProjectsLimit > 0 ? totalActiveProjects / maxProjectsLimit : 0;
    const quotaWarning = projectUsageRatio >= 0.8;

    return {
      summary: summarizeShardCapacity(shards, environment),
      totalActiveProjects,
      maxProjectsLimit,
      projectUsageRatio,
      quotaWarning,
    };
  },
);

function maskToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length <= 8) return '********';
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

/**
 * pingMercadoPagoConnection — Health check en vivo contra Mercado Pago.
 * Llama a GET https://api.mercadopago.com/users/me con el token provisto y
 * devuelve el titular de la cuenta (nickname, email, collector_id) o un error
 * accionable. Nunca persiste el token.
 */
export const pingMercadoPagoConnection = onCall<{ accessToken: string }>(
  { cors: ALLOWED_ORIGINS, invoker: 'public' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError('permission-denied', 'Only platform admins can test MP credentials.');
    }
    const accessToken = String(request.data?.accessToken ?? '').trim();
    if (!accessToken) {
      throw new HttpsError('invalid-argument', 'El Access Token de Mercado Pago es obligatorio.');
    }
    try {
      const res = await fetch('https://api.mercadopago.com/users/me', {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
      if (!res.ok) {
        const details = await res.text();
        return {
          ok: false,
          status: res.status,
          message: `Mercado Pago respondió ${res.status}: ${details.slice(0, 300)}`,
        };
      }
      const user = (await res.json()) as {
        id?: number | string;
        email?: string;
        nickname?: string;
      };
      return {
        ok: true,
        account: {
          id: user.id ?? null,
          email: user.email ?? '',
          nickname: user.nickname ?? '',
        },
        prefix: maskToken(accessToken).slice(0, 12),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 0, message: `Error de conexión: ${msg}` };
    }
  },
);

async function validateMercadoPagoCredentials(
  accessToken: string,
  webhookUrl?: string,
): Promise<{ message: string; accountEmail?: string; userId?: string }> {
  const token = accessToken.trim();
  if (!token) {
    throw new HttpsError('invalid-argument', 'El access token de Mercado Pago es obligatorio.');
  }

  const webhook = (webhookUrl || '').trim();
  if (webhook && !/^https:\/\//i.test(webhook)) {
    throw new HttpsError(
      'invalid-argument',
      'El webhook de Mercado Pago debe comenzar con https://',
    );
  }

  try {
    const res = await fetch('https://api.mercadopago.com/users/me', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const details = await res.text();
      throw new Error(`Mercado Pago respondió ${res.status}: ${details}`);
    }

    const user = (await res.json()) as { id?: number | string; email?: string };

    // Test call to /v1/preferences to verify preference creation permissions
    const testPrefRes = await fetch('https://api.mercadopago.com/v1/preferences', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        items: [
          {
            title: 'Test Preference Validation',
            quantity: 1,
            unit_price: 1.0,
          },
        ],
      }),
    });

    if (testPrefRes.status === 403) {
      throw new Error(
        'El token de Mercado Pago no tiene permisos para crear preferencias de pago (/v1/preferences).',
      );
    }

    return {
      message: `Credenciales válidas para ${user.email || 'cuenta sin email'}.`,
      accountEmail: user.email || undefined,
      userId: user.id ? String(user.id) : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpsError(
      'invalid-argument',
      `No se pudieron validar las credenciales de Mercado Pago. ${msg}`,
    );
  }
}

async function upsertSecretInProject(
  auth: Awaited<ReturnType<typeof getOwnerOAuthClient>>,
  projectId: string,
  secretId: string,
  secretValue: string,
): Promise<void> {
  const tokenRes = await auth.getAccessToken();
  const headers = {
    Authorization: `Bearer ${tokenRes.token}`,
    'Content-Type': 'application/json',
  };

  const createRes = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets?secretId=${encodeURIComponent(secretId)}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ replication: { automatic: {} } }),
    },
  );

  if (!createRes.ok && createRes.status !== 409) {
    const text = await createRes.text();
    throw new HttpsError(
      'internal',
      `No se pudo crear el secreto de Mercado Pago: ${createRes.status} ${text}`,
    );
  }

  const addVersionRes = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${encodeURIComponent(secretId)}:addVersion`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        payload: { data: Buffer.from(secretValue, 'utf8').toString('base64') },
      }),
    },
  );

  if (!addVersionRes.ok) {
    const text = await addVersionRes.text();
    throw new HttpsError(
      'internal',
      `No se pudo guardar versión del secreto de Mercado Pago: ${addVersionRes.status} ${text}`,
    );
  }
}

export const generatePasswordResetLink = onCall<{ storeId: string; email: string }>(
  { cors: ALLOWED_ORIGINS, invoker: 'public' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError('permission-denied', 'Only platform admins can generate reset links.');
    }

    throw new HttpsError(
      'failed-precondition',
      'Password reset links are disabled. Store admin access is Google OAuth only.',
    );
  },
);

export const sendAdvancedTestEmail = onCall(
  {
    cors: ALLOWED_ORIGINS,
  },
  async (request) => {
    const { recipientEmail, testData, templates } = (request.data || {}) as {
      recipientEmail?: string;
      testData?: {
        orderId?: string;
        clientName?: string;
        clientEmail?: string;
        clientPhone?: string;
        totalAmount?: string;
      };
      templates?: {
        adminNotification?: { subject?: string; body?: string };
        customerConfirmation?: { subject?: string; body?: string };
      };
    };

    if (!recipientEmail || !recipientEmail.includes('@')) {
      throw new HttpsError(
        'invalid-argument',
        'El email destinatario es obligatorio y debe ser un correo válido.',
      );
    }

    const orderId = testData?.orderId || 'TEST-1001';
    const clientName = testData?.clientName || 'Cliente Pruebas';
    const totalAmount = testData?.totalAmount || '$15,000';

    const customSubject = templates?.customerConfirmation?.subject;
    const subject = customSubject
      ? customSubject.replace('{orderId}', orderId)
      : `Confirmación de Compra #${orderId} - Tienda SaaS`;

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px; background-color: #ffffff;">
        <h2 style="color: #4f46e5; text-align: center;">¡Gracias por tu compra, ${clientName}!</h2>
        <p style="font-size: 16px; color: #374151; line-height: 1.5;">Este es un email de prueba enviado desde el Gestor de Correos de tu tienda SaaS.</p>
        <div style="background-color: #f3f4f6; padding: 16px; border-radius: 6px; margin: 20px 0;">
          <p style="margin: 6px 0; color: #1f2937;"><strong>Número de Orden:</strong> #${orderId}</p>
          <p style="margin: 6px 0; color: #1f2937;"><strong>Destinatario:</strong> ${clientName} (${recipientEmail})</p>
          <p style="margin: 6px 0; color: #1f2937;"><strong>Monto Total:</strong> ${totalAmount}</p>
        </div>
        <p style="font-size: 13px; color: #6b7280; text-align: center; margin-top: 30px;">
          Motor de Emails Transaccionales Vertex SaaS — 100% Funcional.
        </p>
      </div>
    `;

    const textBody = `¡Gracias por tu compra, ${clientName}! Orden #${orderId}. Total: ${totalAmount}.`;

    try {
      await sendDirectEmail(recipientEmail, subject, htmlBody, textBody);
      return {
        success: true,
        message: `Email de prueba enviado con éxito a ${recipientEmail}`,
      };
    } catch (err: any) {
      console.error('[sendAdvancedTestEmail] Error sending email:', err);
      throw new HttpsError(
        'internal',
        `Error al enviar el correo de prueba: ${err.message || String(err)}`,
      );
    }
  },
);

export const redeployStore = onCall<{ storeId: string }>(
  { cors: ALLOWED_ORIGINS, invoker: 'public' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError('permission-denied', 'Only platform admins can redeploy stores.');
    }
    await checkRateLimit(request.auth?.uid, 'redeployStore', 10, 15);

    const { storeId } = request.data;
    if (!storeId) {
      throw new HttpsError('invalid-argument', 'storeId is required.');
    }

    const db = getFirestore();
    const storeSnap = await db.collection('stores').doc(storeId).get();
    if (!storeSnap.exists) throw new HttpsError('not-found', 'Store not found.');

    const store = storeSnap.data() as {
      id: string;
      name: string;
      slug?: string;
      tenantId?: string;
      runtimeSiteId?: string;
      firebaseProjectId?: string;
      runtimeProjectId?: string;
      runtimeMode?: string;
      templateVersion?: string;
      autoUpdate?: boolean;
      environment?: 'development' | 'production';
    };

    const projectId = resolveRuntimeProjectId(store);
    const runtimeSiteId = store.runtimeSiteId || store.id;
    const tenantId = store.slug || store.tenantId || store.id;

    const configSnap = await db
      .collection('stores')
      .doc(storeId)
      .collection('private')
      .doc('firebaseConfig')
      .get();

    if (!configSnap.exists) {
      throw new HttpsError('failed-precondition', 'Store firebase config is not found.');
    }
    const firebaseConfig = configSnap.data();

    const pat = await getGitHubPat();
    const deployTokenValue = await getDeployToken();
    const env = resolvePlatformEnvironment(PLATFORM_PROJECT);
    const isStoreDev =
      store.environment === 'development' ||
      String(store.firebaseProjectId || store.runtimeProjectId || '').includes('-dev');
    const targetRef = env === 'production' ? 'main' : env === 'local' ? 'local' : 'develop';
    // Lógica de actualización segura:
    // - En develop (sandbox): solo si autoUpdate=true Y la tienda es de desarrollo califica a 'develop'. Si es de producción, NUNCA compila develop.
    // - En main (producción): si autoUpdate=true compila 'main'. Si autoUpdate=false compila estrictamente su templateVersion fijada.
    const ref =
      store.autoUpdate === true
        ? env === 'development'
          ? isStoreDev
            ? 'develop'
            : store.templateVersion
              ? `refs/tags/v${store.templateVersion.replace(/^v/, '')}`
              : 'main'
          : targetRef
        : store.templateVersion
          ? `refs/tags/v${store.templateVersion.replace(/^v/, '')}`
          : targetRef;

    await db.collection('stores').doc(storeId).update({
      redeployStatus: 'deploying',
      redeployError: null,
      redeployStartedAt: new Date(),
      updatedAt: new Date(),
    });

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
          client_payload: {
            store_id: storeId,
            tenant_id: tenantId,
            project_id: projectId,
            site_id: runtimeSiteId,
            firebase_config: JSON.stringify(firebaseConfig),
            platform_project_id: PLATFORM_PROJECT,
            deploy_token: deployTokenValue,
            environment: env,
            version: store.templateVersion || '0.4.0',
            ref: ref,
          },
        }),
      },
    );

    if (!res.ok && res.status !== 204) {
      const body = await res.text();
      console.error('redeployStore GitHub dispatch error:', res.status, body);
      await db.collection('stores').doc(storeId).update({
        redeployStatus: 'failed',
        redeployError: 'No se pudo iniciar el flujo de compilación en GitHub Actions.',
        updatedAt: new Date(),
      });
      throw new HttpsError('internal', 'Failed to trigger deployment. Please try again.');
    }

    return { success: true };
  },
);

/**
 * Dispara el deploy de una tienda vía GitHub Actions (provision-store con la versión activa).
 * Compartido por redeployStore y activateStore.
 */
async function dispatchStoreDeployment(storeId: string): Promise<void> {
  const db = getFirestore();
  const snap = await db.collection('stores').doc(storeId).get();
  if (!snap.exists) throw new Error('Store not found.');
  const store = snap.data() as {
    id: string;
    name: string;
    slug?: string;
    tenantId?: string;
    runtimeSiteId?: string;
    firebaseProjectId?: string;
    runtimeProjectId?: string;
    templateVersion?: string;
    autoUpdate?: boolean;
    environment?: 'development' | 'production';
  };
  const projectId = resolveRuntimeProjectId(store);
  const runtimeSiteId = store.runtimeSiteId || store.id;
  const tenantId = store.slug || store.tenantId || store.id;

  const configSnap = await db
    .collection('stores')
    .doc(storeId)
    .collection('private')
    .doc('firebaseConfig')
    .get();
  if (!configSnap.exists) throw new Error('Store firebase config is not found.');
  const firebaseConfig = configSnap.data();

  const pat = await getGitHubPat();
  const deployTokenValue = await getDeployToken();
  const env = resolvePlatformEnvironment(PLATFORM_PROJECT);
  const isStoreDev =
    store.environment === 'development' ||
    String(store.firebaseProjectId || store.runtimeProjectId || '').includes('-dev');
  const targetRef = env === 'production' ? 'main' : env === 'local' ? 'local' : 'develop';
  // Lógica de actualización segura:
  // - En develop (sandbox): solo si autoUpdate=true Y la tienda es de desarrollo califica a 'develop'. Si es de producción, NUNCA compila develop.
  // - En main (producción): si autoUpdate=true compila 'main'. Si autoUpdate=false compila estrictamente su templateVersion fijada.
  const ref =
    store.autoUpdate === true
      ? env === 'development'
        ? isStoreDev
          ? 'develop'
          : store.templateVersion
            ? `refs/tags/v${store.templateVersion.replace(/^v/, '')}`
            : 'main'
        : targetRef
      : store.templateVersion
        ? `refs/tags/v${store.templateVersion.replace(/^v/, '')}`
        : targetRef;

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
        client_payload: {
          store_id: storeId,
          tenant_id: tenantId,
          project_id: projectId,
          site_id: runtimeSiteId,
          firebase_config: JSON.stringify(firebaseConfig),
          store_name: store.name,
          platform_project_id: PLATFORM_PROJECT,
          deploy_token: deployTokenValue,
          environment: env,
          ref: ref,
        },
      }),
    },
  );
  if (!res.ok && res.status !== 204) {
    const body = await res.text();
    throw new Error(`GitHub dispatch failed: ${res.status} ${body}`);
  }
}

/**
 * Sistema de "dormir" tiendas (suspender sin eliminar) — para manejar pagos:
 *  - suspendStore: marca suspended, despliega un tombstone (sitio "tienda pausada"),
 *    queda excluida de getActiveStores/deploys, y conserva TODOS los datos y su cupo.
 *  - activateStore: marca active y re-despliega el sitio con su versión actual.
 */
export const suspendStore = onCall<{ storeId: string }>(
  { cors: ALLOWED_ORIGINS, invoker: 'public', timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError('permission-denied', 'Only platform admins can suspend stores.');
    }
    await checkRateLimit(request.auth?.uid, 'suspendStore', 10, 15);

    const { storeId } = request.data;
    if (!storeId) throw new HttpsError('invalid-argument', 'storeId is required.');

    const db = getFirestore();
    const storeRef = db.collection('stores').doc(storeId);
    const snap = await storeRef.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Store not found.');
    const store = snap.data() as {
      status?: string;
      runtimeProjectId?: string;
      firebaseProjectId?: string;
      runtimeSiteId?: string;
      provisioningOwnerId?: string;
    };
    if (store.status === 'suspended') {
      return { success: true, already: true };
    }

    const projectId = resolveRuntimeProjectId(store);
    const siteId = store.runtimeSiteId || storeId;
    try {
      await withAnyProvisioningOwner(db, store.provisioningOwnerId ?? undefined, async (auth) =>
        deployHostingTombstone(auth, projectId, siteId),
      );
    } catch (err) {
      console.warn(`[suspendStore] Tombstone deploy no bloqueante falló para ${storeId}:`, err);
    }

    await storeRef.update({
      status: 'suspended',
      suspendedAt: new Date(),
      updatedAt: new Date(),
    });
    await logAuditAction(
      request.auth.uid,
      request.auth.token.email,
      'suspendStore',
      storeId,
      'success',
    );
    return { success: true };
  },
);

export const activateStore = onCall<{ storeId: string }>(
  { cors: ALLOWED_ORIGINS, invoker: 'public', timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError('permission-denied', 'Only platform admins can activate stores.');
    }
    await checkRateLimit(request.auth?.uid, 'activateStore', 10, 15);

    const { storeId } = request.data;
    if (!storeId) throw new HttpsError('invalid-argument', 'storeId is required.');

    const db = getFirestore();
    const storeRef = db.collection('stores').doc(storeId);
    const snap = await storeRef.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Store not found.');
    const store = snap.data() as { status?: string };
    if (store.status !== 'suspended') {
      throw new HttpsError('failed-precondition', 'Solo se pueden activar tiendas suspendidas.');
    }

    await storeRef.update({
      status: 'active',
      suspendedAt: null,
      updatedAt: new Date(),
    });

    // Re-desplegar el sitio (misma lógica de redeployStore — provision-store con la versión activa).
    try {
      await dispatchStoreDeployment(storeId);
    } catch (err) {
      console.warn(
        `[activateStore] Dispatch de redeploy falló (se reintentará manualmente) ${storeId}:`,
        err,
      );
    }

    await logAuditAction(
      request.auth.uid,
      request.auth.token.email,
      'activateStore',
      storeId,
      'success',
    );
    return { success: true };
  },
);

export const deleteStore = onCall<{ storeId: string }>(
  { timeoutSeconds: 300, cors: ALLOWED_ORIGINS, invoker: 'public' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError('permission-denied', 'Only platform admins can delete stores.');
    }
    await checkRateLimit(request.auth?.uid, 'deleteStore', 10, 15);

    const { storeId } = request.data;
    const db = getFirestore();
    const storeSnap = await db.collection('stores').doc(storeId).get();
    if (!storeSnap.exists) throw new HttpsError('not-found', 'Store not found.');

    const store = storeSnap.data() as {
      firebaseProjectId?: string;
      runtimeProjectId?: string;
      runtimeSiteId?: string;
      runtimeMode?: StoreRuntimeMode;
      defaultUrl?: string;
      provisioningOwnerId?: string;
      shardId?: string;
    };

    const siteId = resolveRuntimeSiteId(store);
    const runtimeMode = store.runtimeMode ?? 'dedicated-project';
    const inferredProjectId = inferProjectIdFromDefaultUrl(store.defaultUrl);
    // Política de pool: los shards NUNCA se eliminan al vaciarse — permanecen
    // disponibles para tiendas futuras (el usuario lo pidió explícitamente).
    // Solo se elimina el proyecto si DELETE_EMPTY_SHARDS === 'true' (opt-in).
    let deleteProjectOnCleanup = false;
    if (runtimeMode === 'shared-shard' && store.shardId) {
      const optIn = process.env['DELETE_EMPTY_SHARDS'] === 'true';
      if (optIn) {
        try {
          const shardSnap = await db.collection('infrastructure_shards').doc(store.shardId).get();
          if (shardSnap.exists) {
            const shardData = shardSnap.data() ?? {};
            const shardProjectId = String(shardData['projectId'] ?? '');
            const willBeEmpty = (shardData['currentStores'] ?? 0) - 1 <= 0;
            deleteProjectOnCleanup = willBeEmpty && isDisposableProject(shardProjectId);
          }
        } catch (err) {
          console.warn(`[deleteStore] No se pudo evaluar el shard ${store.shardId}:`, err);
        }
      }
    }

    const candidateProjectIds = Array.from(
      new Set(
        [store.runtimeProjectId, store.firebaseProjectId, inferredProjectId]
          .map((value) => (value || '').trim())
          .filter((value) => value.length > 0),
      ),
    );

    if (candidateProjectIds.length > 0) {
      await enqueueRuntimeCleanupTask(db, {
        storeId,
        preferredOwnerId: store.provisioningOwnerId,
        projectIds: candidateProjectIds,
        siteId,
        runtimeMode,
        deleteProject: deleteProjectOnCleanup,
        reason: 'deleteStore-postcheck',
      });
    }

    // Delete 'private' subcollection
    const privateRef = db.collection('stores').doc(storeId).collection('private');
    const privateDocs = await privateRef.listDocuments();
    await Promise.all(privateDocs.map((d) => d.delete()));

    // Delete 'invitations' subcollection
    const invitationsRef = db.collection('stores').doc(storeId).collection('invitations');
    const invitationsDocs = await invitationsRef.listDocuments();
    await Promise.all(invitationsDocs.map((d) => d.delete()));

    // Decrement the currentStores count on the shard if this store was hosted on a shared-shard
    if (store.runtimeMode === 'shared-shard' && store.shardId) {
      const shardRef = db.collection('infrastructure_shards').doc(store.shardId);
      try {
        await db.runTransaction(async (transaction) => {
          const shardSnap = await transaction.get(shardRef);
          if (shardSnap.exists) {
            const shardData = shardSnap.data()!;
            const currentStores = shardData['currentStores'] || 0;
            const maxCapacity = shardData['maxCapacity'] || DEFAULT_MAX_STORES_PER_SHARD;
            const newCount = Math.max(0, currentStores - 1);
            // Liberar cupo real: al bajar del máximo, un shard FULL vuelve a ACTIVE
            // (disponible para nuevas tiendas — el pool nunca se elimina).
            const newStatus =
              shardData['status'] === 'FULL' && newCount < maxCapacity
                ? 'ACTIVE'
                : shardData['status'];
            transaction.update(shardRef, {
              currentStores: newCount,
              ...(newStatus !== shardData['status'] ? { status: newStatus } : {}),
              updatedAt: new Date(),
            });
          }
        });
      } catch (err) {
        console.error(
          `[deleteStore] Failed to decrement currentStores on shard ${store.shardId}:`,
          err,
        );
      }
      // Shard desechable vacío: eliminarlo (el cleanup eliminará el proyecto GCP/Firebase)
      if (deleteProjectOnCleanup) {
        await shardRef
          .delete()
          .then(() => console.info(`[deleteStore] Shard desechable ${store.shardId} eliminado.`))
          .catch((err) =>
            console.warn(`[deleteStore] No se pudo eliminar el shard ${store.shardId}:`, err),
          );
      }
    }

    // Delete store document
    await db.collection('stores').doc(storeId).delete();

    await logAuditAction(
      request.auth?.uid || 'unknown',
      request.auth?.token.email as string | undefined,
      'deleteStore',
      storeId,
      'success',
    );

    return { success: true };
  },
);

/**
 * Borra TODOS los documentos de la tienda en un proyecto (shard) usando
 * collectionGroup queries por storeId — productos, órdenes, clientes, atributos,
 * configuracion, banners, páginas, settings, mail, reviews, store_payments.
 * Batch de 400 docs con presupuesto de tiempo para no exceder el timeout.
 */
async function deleteStoreDataInProject(
  db: ReturnType<typeof getFirestore>,
  projectId: string,
  storeId: string,
): Promise<void> {
  const collections = [
    'products',
    'orders',
    'clients',
    'attributes',
    'configuracion',
    'banners',
    'pages',
    'settings',
    'mail',
    'reviews',
    'store_payments',
  ];
  const deadline = Date.now() + 120_000; // 2 min presupuesto
  for (const collection of collections) {
    if (Date.now() > deadline) break;
    try {
      // collectionGroup sobre la DB del proyecto: admin SDK con firestore() del shard
      const shardDb = getFirestoreForProject(projectId);
      let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
      let deletedInCollection = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (Date.now() > deadline) break;
        let query = shardDb.collectionGroup(collection).where('storeId', '==', storeId).limit(400);
        if (cursor) {
          query = query.startAfter(cursor);
        }
        const snap = await query.get();
        if (snap.empty) break;
        const batch = shardDb.batch();
        snap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        deletedInCollection += snap.size;
        cursor = snap.docs[snap.size - 1];
        if (snap.size < 400) break;
      }
      if (deletedInCollection > 0) {
        console.info(
          `[runtimeCleanup] Eliminados ${deletedInCollection} docs de ${collection} (${storeId} en ${projectId})`,
        );
      }
    } catch (err) {
      console.warn(`[runtimeCleanup] No se pudieron borrar ${collection} de ${storeId}:`, err);
    }
  }
}

/**
 * Obtiene una instancia de Firestore admin para un proyecto de shard.
 */
function getFirestoreForProject(projectId: string): FirebaseFirestore.Firestore {
  return (getFirestoreForProjectCache[projectId] ??= firestoreForProject(projectId));
}

const getFirestoreForProjectCache: Record<string, FirebaseFirestore.Firestore> = {};

function firestoreForProject(projectId: string): FirebaseFirestore.Firestore {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { initializeApp, getApps } =
    require('firebase-admin/app') as typeof import('firebase-admin/app');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getFirestore: adminGetFirestore } =
    require('firebase-admin/firestore') as typeof import('firebase-admin/firestore');
  const appName = `shard-${projectId}`;
  const existing = getApps().find((a) => a.name === appName);
  const app = existing ?? initializeApp({ projectId }, appName);
  return adminGetFirestore(app);
}

export const processRuntimeCleanupTask = onDocumentCreated(
  { document: 'runtimeCleanupTasks/{taskId}', timeoutSeconds: 300 },
  async (event) => {
    const snap = event.data;
    if (!snap?.exists) {
      return;
    }

    const db = getFirestore();
    const taskId = event.params['taskId'];
    const taskRef = db.collection('runtimeCleanupTasks').doc(taskId);
    const task = snap.data() as {
      preferredOwnerId?: string | null;
      projectIds?: string[];
      siteId?: string;
      storeId?: string;
      runtimeMode?: StoreRuntimeMode;
      deleteProject?: boolean;
      attempts?: number;
    };

    const projectIds = Array.from(
      new Set((task.projectIds ?? []).map((id) => (id || '').trim()).filter((id) => id.length > 0)),
    );
    const siteId = (task.siteId || 'default').trim() || 'default';
    const runtimeMode = task.runtimeMode ?? 'dedicated-project';

    if (projectIds.length === 0) {
      await taskRef.set(
        {
          status: 'error',
          lastError: 'No projectIds provided for cleanup task.',
          updatedAt: new Date(),
        },
        { merge: true },
      );
      return;
    }

    await taskRef.set(
      {
        status: 'running',
        attempts: (task.attempts ?? 0) + 1,
        updatedAt: new Date(),
      },
      { merge: true },
    );

    try {
      if (runtimeMode === 'dedicated-project') {
        for (const projectId of projectIds) {
          const candidateSiteIds = getCandidateSiteIds(siteId, projectId);

          // 1. Clean up hosting site custom domains
          let hostingDeleted = false;
          let hostingCandidateGone = false;
          let lastHostingError: unknown = null;
          for (const candidateSiteId of candidateSiteIds) {
            try {
              await withAnyProvisioningOwner(db, task.preferredOwnerId ?? undefined, async (auth) =>
                deleteHostingSite(auth, projectId, candidateSiteId),
              );
              hostingDeleted = true;
              break;
            } catch (err) {
              if (isHostingAlreadyGoneOrInactiveError(err)) {
                hostingCandidateGone = true;
                continue;
              }
              lastHostingError = err;
            }
          }

          if (!hostingDeleted) {
            if (lastHostingError) {
              throw lastHostingError;
            }
            if (!hostingCandidateGone) {
              throw new Error(
                `[runtimeCleanup] No Hosting site candidate could be validated for ${projectId}.`,
              );
            }
          }

          // 2. Deploy Tombstone immediately (Defensive Fallback)
          // We deploy this BEFORE attempting project deletion so that if project deletion fails or times out,
          // the canal is already safely tombstoned publicly.
          for (const candidateSiteId of candidateSiteIds) {
            try {
              await withAnyProvisioningOwner(db, task.preferredOwnerId ?? undefined, async (auth) =>
                deployHostingTombstone(auth, projectId, candidateSiteId),
              );
              break;
            } catch (err) {
              if (isHostingAlreadyGoneOrInactiveError(err)) {
                continue;
              }
              console.warn(
                `[runtimeCleanup] Tombstone deploy failed for candidate ${candidateSiteId}:`,
                err,
              );
            }
          }

          // 3. Attempt physical project deletion
          try {
            await withAnyProvisioningOwner(db, task.preferredOwnerId ?? undefined, async (auth) =>
              deleteProjectAndWait(auth, projectId),
            );
          } catch (err) {
            if (!isProjectAlreadyDeletedOrInactiveError(err)) {
              throw err;
            }
          }
        }
      } else {
        // shared-shard: tombstone first to deactivate the store immediately,
        // then clean up the custom hosting site (non-blocking if already gone).
        for (const projectId of projectIds) {
          const candidateSiteIds = getCandidateSiteIds(siteId, projectId);

          // 1. Deploy tombstone first so the store goes dark instantly
          for (const candidateSiteId of candidateSiteIds) {
            try {
              await withAnyProvisioningOwner(db, task.preferredOwnerId ?? undefined, async (auth) =>
                deployHostingTombstone(auth, projectId, candidateSiteId),
              );
              break;
            } catch (err) {
              if (isHostingAlreadyGoneOrInactiveError(err)) {
                continue;
              }
              console.warn(
                `[runtimeCleanup] Tombstone deploy failed for shared-shard candidate ${candidateSiteId}:`,
                err,
              );
            }
          }

          // 2. Delete the custom hosting site (skip if it's the project default site)
          let hostingDeleted = false;
          let hostingAlreadyGone = false;
          let lastHostingError: unknown = null;
          for (const candidateSiteId of candidateSiteIds) {
            try {
              await withAnyProvisioningOwner(db, task.preferredOwnerId ?? undefined, async (auth) =>
                deleteHostingSite(auth, projectId, candidateSiteId),
              );
              hostingDeleted = true;
              break;
            } catch (err) {
              if (isHostingAlreadyGoneOrInactiveError(err)) {
                hostingAlreadyGone = true;
                continue;
              }
              lastHostingError = err;
            }
          }

          if (!hostingDeleted && !hostingAlreadyGone && lastHostingError) {
            throw lastHostingError;
          }

          // 3. Borrado TOTAL de los datos de la tienda en el shard (collectionGroup por storeId)
          if (task.storeId) {
            await deleteStoreDataInProject(db, projectId, task.storeId);
          }

          // 4. Si el shard desechable quedó vacío (deleteProject flag + opt-in),
          //    eliminar el proyecto GCP/Firebase. Por defecto el shard permanece en el pool.
          if (task.deleteProject === true && isDisposableProject(projectId)) {
            try {
              await withAnyProvisioningOwner(db, task.preferredOwnerId ?? undefined, async (auth) =>
                deleteProjectAndWait(auth, projectId),
              );
              console.info(
                `[runtimeCleanup] Proyecto desechable ${projectId} eliminado (shard vacío).`,
              );
            } catch (err) {
              if (!isProjectAlreadyDeletedOrInactiveError(err)) {
                throw err;
              }
            }
          }
        }
      }

      await taskRef.set(
        {
          status: 'done',
          completedAt: new Date(),
          updatedAt: new Date(),
        },
        { merge: true },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await taskRef.set(
        {
          status: 'error',
          lastError: msg,
          updatedAt: new Date(),
        },
        { merge: true },
      );
      throw err;
    }
  },
);

/**
 * Sanitización universal de dominios (backend): quita protocolo, 'www.', barras,
 * paths, puertos y normaliza a minúsculas. Permite ccTLDs (.com.ar) y subdominios.
 */
function sanitizeDomainName(raw: string): string {
  let d = String(raw ?? '')
    .trim()
    .toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // http:// https://
  d = (d.split(/[/?#]/)[0] || d).trim(); // quitar path/query/hash
  d = d.replace(/:\d{1,5}$/, ''); // puerto
  d = d.replace(/^www\./, ''); // www. inicial
  d = d.replace(/\.+$/, ''); // puntos finales
  return d.trim();
}

export const connectDomain = onCall<{ storeId: string; domain: string }>(
  { cors: ALLOWED_ORIGINS, invoker: 'public' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError('permission-denied', 'Only platform admins can connect domains.');
    }

    const { storeId, domain: rawDomain } = request.data;
    if (!storeId || !/^[a-zA-Z0-9_-]{1,100}$/.test(storeId)) {
      throw new HttpsError('invalid-argument', 'Invalid storeId.');
    }
    // Sanitización determinista + regex compatible con ccTLDs y subdominios.
    const domain = sanitizeDomainName(rawDomain);
    if (
      !domain ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/i.test(domain)
    ) {
      throw new HttpsError(
        'invalid-argument',
        'Formato de dominio inválido. Usá un dominio sin protocolo (ej.: miempresa.com.ar).',
      );
    }

    await checkRateLimit(request.auth?.uid, 'connectDomain', 10, 15);

    const db = getFirestore();
    const storeSnap = await db.collection('stores').doc(storeId).get();
    if (!storeSnap.exists) throw new HttpsError('not-found', 'Store not found.');

    const store = storeSnap.data() as {
      firebaseProjectId?: string;
      runtimeProjectId?: string;
      runtimeSiteId?: string;
      ownerEmail?: string;
      provisioningOwnerId?: string;
    };

    const authEmail = request.auth?.token.email as string | undefined;
    if (!isOwnerOrSuperAdmin(authEmail, store.ownerEmail)) {
      throw new HttpsError('permission-denied', 'You do not have permission to manage this store.');
    }

    const projectId = resolveRuntimeProjectId(store);
    const siteId = resolveRuntimeSiteId(store);
    if (!projectId) {
      throw new HttpsError('failed-precondition', 'Store has no associated Firebase project.');
    }

    const auth = await getOwnerOAuthClient(store.provisioningOwnerId);

    if (process.env.FUNCTIONS_EMULATOR === 'true') {
      await db.collection('stores').doc(storeId).update({
        customDomain: domain,
        updatedAt: new Date(),
      });
      const dnsRecords = [
        { domainName: domain, type: 'A', rdata: '199.36.158.100', requiredAction: 'ADD' },
        {
          domainName: `www.${domain}`,
          type: 'CNAME',
          rdata: `${siteId}.web.app`,
          requiredAction: 'ADD',
        },
      ];
      return { success: true, dnsRecords };
    }

    const tokenRes = await auth.getAccessToken();
    const res = await fetch(
      `https://firebasehosting.googleapis.com/v1beta1/projects/${projectId}/sites/${siteId}/domains`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenRes.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ domainName: domain, site: siteId }),
      },
    );

    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`[connectDomain] Firebase Hosting error: ${res.status}`, {
        projectId,
        siteId,
        domain,
        errorBody,
      });

      if (res.status === 400) {
        throw new HttpsError(
          'invalid-argument',
          'El dominio no es válido o no coincide con el sitio del shard.',
        );
      }
      if (res.status === 403)
        throw new HttpsError('permission-denied', 'Insufficient permissions.');
      if (res.status === 404) throw new HttpsError('not-found', 'Site or project not found.');
      if (res.status === 409) {
        // Idempotencia: el dominio ya está conectado (409/ALREADY_EXISTS). No es un
        // error: continuamos para devolver los registros DNS vigentes (200 OK).
        console.warn(
          `[connectDomain] Domain already connected (409) on ${domain} — idempotent OK.`,
        );
      } else {
        throw new HttpsError('internal', 'Failed to connect domain.');
      }
    }
    // La API de Hosting NO incluye requiredDnsUpdates en la respuesta del create;
    // se obtienen vía GET del recurso (provisioning.expectedIps) o el estándar de Firebase.
    let dnsRecords: { domainName: string; type: string; rdata: string; requiredAction: string }[] =
      [];
    try {
      const getRes = await fetch(
        `https://firebasehosting.googleapis.com/v1beta1/projects/${projectId}/sites/${siteId}/domains/${domain}`,
        { headers: { Authorization: `Bearer ${tokenRes.token}` } },
      );
      let ips = ['199.36.158.100'];
      if (getRes.ok) {
        const dom = (await getRes.json()) as { provisioning?: { expectedIps?: string[] } };
        if (dom.provisioning?.expectedIps?.length) {
          ips = dom.provisioning.expectedIps;
        }
      }
      const isSubdomain = domain.split('.').length > 2;
      dnsRecords = [
        {
          domainName: isSubdomain ? domain.split('.')[0] : '@',
          type: 'A',
          rdata: ips[0] || '199.36.158.100',
          requiredAction: 'ADD',
        },
        {
          domainName: 'www',
          type: 'CNAME',
          rdata: `${siteId}.web.app`,
          requiredAction: 'ADD',
        },
      ];
    } catch (dnsErr) {
      console.warn(`[connectDomain] Could not fetch DNS records for ${domain}:`, dnsErr);
    }

    // Sincronizar el dominio en authorizedDomains de Firebase Auth del shard
    // para que Google OAuth funcione desde el dominio custom.
    try {
      const authTokenRes = await auth.getAccessToken();
      const identityUrl = `https://identitytoolkit.googleapis.com/admin/v2/projects/${projectId}/config`;
      const cfgRes = await fetch(identityUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${authTokenRes.token}` },
      });
      if (cfgRes.ok) {
        const cfgData = (await cfgRes.json()) as { authorizedDomains?: string[] };
        const existing = cfgData.authorizedDomains ?? [];
        const toAdd = [domain, `www.${domain}`];
        const updated = [...new Set([...existing, ...toAdd])];
        if (updated.length !== existing.length) {
          await fetch(`${identityUrl}?updateMask=authorizedDomains`, {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${authTokenRes.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ authorizedDomains: updated }),
          });
        }
      }
    } catch (e) {
      console.warn(`[connectDomain] Could not update authorizedDomains for ${projectId}:`, e);
    }

    await db.collection('stores').doc(storeId).update({
      customDomain: domain,
      updatedAt: new Date(),
    });

    await logAuditAction(
      request.auth?.uid || 'unknown',
      authEmail,
      'connectDomain',
      storeId,
      'success',
      { domain },
    );

    return { success: true, dnsRecords };
  },
);

/**
 * getDomainStatus — Estado en vivo del dominio en Firebase Hosting.
 * Mapea dnsStatus/certStatus del provisioning a PENDING_DNS | VALIDATING | ACTIVE
 * y devuelve registros A (expectedIps) y TXT (verificación de propiedad) si aplica.
 */
export const getDomainStatus = onCall<{ storeId: string; domain?: string }>(
  { cors: ALLOWED_ORIGINS, invoker: 'public' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError('permission-denied', 'Only platform admins can check domain status.');
    }
    const { storeId } = request.data;
    if (!storeId || !/^[a-zA-Z0-9_-]{1,100}$/.test(storeId)) {
      throw new HttpsError('invalid-argument', 'Invalid storeId.');
    }
    const db = getFirestore();
    const storeSnap = await db.collection('stores').doc(storeId).get();
    if (!storeSnap.exists) throw new HttpsError('not-found', 'Store not found.');
    const store = storeSnap.data() as {
      customDomain?: string;
      runtimeProjectId?: string;
      runtimeSiteId?: string;
      firebaseProjectId?: string;
      provisioningOwnerId?: string;
    };
    const projectId = resolveRuntimeProjectId(store);
    const siteId = resolveRuntimeSiteId(store);
    const domain = sanitizeDomainName(request.data?.domain || store.customDomain || '');
    if (!domain || !projectId || !siteId) {
      throw new HttpsError('failed-precondition', 'La tienda no posee dominio vinculado o sitio.');
    }
    let data: {
      provisioning?: { dnsStatus?: string; certStatus?: string; expectedIps?: string[] };
      requiredDnsUpdates?: Array<{ domainName?: string; type?: string; rdata?: string }>;
      status?: string;
    } = {};

    try {
      const auth = await getOwnerOAuthClient(store.provisioningOwnerId as string | undefined);
      const token = (await auth.getAccessToken()).token;
      const res = await fetch(
        `https://firebasehosting.googleapis.com/v1beta1/projects/${projectId}/sites/${siteId}/domains/${encodeURIComponent(domain)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        console.warn(`[getDomainStatus] Hosting API warning (${res.status}) para ${domain}`);
      } else {
        data = (await res.json()) as typeof data;
      }
    } catch (fetchErr) {
      console.warn('[getDomainStatus] Error consultando dominio:', fetchErr);
    }
    const dnsReady =
      (data.provisioning?.dnsStatus || '') === 'ACTIVE' ||
      (data.status || '') === 'ACTIVE' ||
      (data.status || '') === 'DOMAIN_ACTIVE';
    const certReady =
      (data.provisioning?.certStatus || '') === 'ACTIVE' ||
      (data.status || '') === 'ACTIVE' ||
      (data.status || '') === 'DOMAIN_ACTIVE';
    const txt =
      data.requiredDnsUpdates?.find((d) => (d.type || '').toUpperCase() === 'TXT')?.rdata || '';
    const aRecords = (data.provisioning?.expectedIps || []).length
      ? data.provisioning!.expectedIps!
      : data.requiredDnsUpdates
          ?.filter((d) => (d.type || '').toUpperCase() === 'A')
          .map((d) => d.rdata || '')
          .filter((v) => !!v) || [];
    return {
      success: true,
      domain,
      status: dnsReady && certReady ? 'ACTIVE' : txt ? 'PENDING_DNS' : 'VALIDATING',
      sslStatus: certReady ? 'ACTIVE' : 'PENDING',
      dnsRecords: { aRecords: aRecords as string[], txtRecord: txt || undefined },
    };
  },
);

/**
 * disconnectDomain — Desvincula el dominio: elimina el mapeo en Firebase Hosting
 * y limpia customDomain/domains en el documento de la tienda.
 */
export const disconnectDomain = onCall<{ storeId: string; domain?: string }>(
  { cors: ALLOWED_ORIGINS, invoker: 'public' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError('permission-denied', 'Only platform admins can disconnect domains.');
    }
    const { storeId } = request.data;
    if (!storeId || !/^[a-zA-Z0-9_-]{1,100}$/.test(storeId)) {
      throw new HttpsError('invalid-argument', 'Invalid storeId.');
    }
    const db = getFirestore();
    const storeSnap = await db.collection('stores').doc(storeId).get();
    if (!storeSnap.exists) throw new HttpsError('not-found', 'Store not found.');
    const store = storeSnap.data() as {
      customDomain?: string;
      runtimeProjectId?: string;
      runtimeSiteId?: string;
      firebaseProjectId?: string;
      domains?: string[];
      provisioningOwnerId?: string;
    };
    const projectId = resolveRuntimeProjectId(store);
    const siteId = resolveRuntimeSiteId(store);
    const domain = sanitizeDomainName(request.data?.domain || store.customDomain || '');
    if (!domain || !projectId || !siteId) {
      throw new HttpsError('failed-precondition', 'La tienda no posee dominio vinculado o sitio.');
    }
    const auth = await getOwnerOAuthClient(store.provisioningOwnerId as string | undefined);
    const token = (await auth.getAccessToken()).token;
    try {
      await fetch(
        `https://firebasehosting.googleapis.com/v1beta1/projects/${projectId}/sites/${siteId}/domains/${encodeURIComponent(domain)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      );
    } catch (delErr) {
      const msg = delErr instanceof Error ? delErr.message : String(delErr);
      if (!/404|not.?found/i.test(msg)) throw delErr;
    }
    const patch: Record<string, unknown> = { customDomain: null, updatedAt: new Date() };
    if (Array.isArray(store.domains)) {
      patch['domains'] = (store.domains || []).filter((d) => d !== domain);
    }
    await db.collection('stores').doc(storeId).update(patch);
    return { success: true, domain, message: 'Dominio desvinculado correctamente.' };
  },
);

export const getActiveStores = onCall(
  { cors: ALLOWED_ORIGINS, invoker: 'public' },
  async (request) => {
    const deployToken = request.data?.deployToken as string | undefined;
    const idToken = request.data?.idToken as string | undefined;
    const isAdmin = !!request.auth?.token['platformAdmin'];

    // Exigir autorización en TODOS los entornos:
    // 1) admin de plataforma, 2) GitHub OIDC (workflow automatizado), 3) deploy token legacy.
    if (!isAdmin) {
      if (idToken) {
        const oidcValid = await verifyGitHubOidcToken(idToken, {
          repository: 'vertex-solutions-ar/ecommerce-vertex',
        });
        if (!oidcValid) {
          throw new HttpsError('permission-denied', 'Invalid GitHub OIDC token.');
        }
      } else if (deployToken) {
        const expected = await getDeployToken();
        if (deployToken !== expected) {
          throw new HttpsError('permission-denied', 'Invalid deploy token.');
        }
      } else {
        throw new HttpsError('permission-denied', 'Unauthorized.');
      }
    }

    const db = getFirestore();
    const snap = await db.collection('stores').where('status', '==', 'active').get();

    const stores = await Promise.all(
      snap.docs.map(async (doc) => {
        const store = doc.data() as {
          id: string;
          name: string;
          firebaseProjectId?: string;
          runtimeProjectId?: string;
          slug?: string;
          tenantId?: string;
          runtimeSiteId?: string;
          autoUpdate?: boolean;
          templateVersion?: string;
        };
        let projectId: string;
        try {
          projectId = resolveRuntimeProjectId(store);
        } catch (e) {
          console.warn(
            `Store ${store.id} is active but has no runtime project configured. Skipping.`,
            e,
          );
          return null;
        }

        const configSnap = await db
          .collection('stores')
          .doc(doc.id)
          .collection('private')
          .doc('firebaseConfig')
          .get();

        return {
          storeId: store.id,
          tenantId: store.slug || store.tenantId || store.id,
          siteId: store.runtimeSiteId || store.id,
          autoUpdate: store.autoUpdate !== false,
          templateVersion: store.templateVersion || null,
          projectId,
          storeName: store.name,
          firebaseConfig: configSnap.exists ? JSON.stringify(configSnap.data()) : null,
        };
      }),
    );

    return {
      stores: stores.filter(
        (s): s is NonNullable<typeof s> => s !== null && s.firebaseConfig !== null,
      ),
    };
  },
);

/** Serializa un payload anidado a `fields` de Firestore REST (valores string/boolean). */
function toFirestoreFieldsForPayments(payload: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') {
      out[k] = { mapValue: { fields: toFirestoreFieldsForPayments(v as Record<string, any>) } };
    } else if (typeof v === 'boolean') {
      out[k] = { booleanValue: v };
    } else {
      out[k] = { stringValue: String(v) };
    }
  }
  return out;
}

export const updateStoreConfig = onCall<UpdateStoreConfigPayload>(
  { cors: ALLOWED_ORIGINS, invoker: 'public' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError('permission-denied', 'Only platform admins can update store configs.');
    }
    await checkRateLimit(request.auth?.uid, 'updateStoreConfig', 30, 15);

    const { storeId, config } = request.data;
    if (!storeId || !config) {
      throw new HttpsError('invalid-argument', 'storeId and config are required.');
    }

    const configToSave = JSON.parse(JSON.stringify(config)) as Record<string, any>;
    const mercadoPago = configToSave['payments']?.['mercadoPago'] as
      | Record<string, any>
      | undefined;
    if (mercadoPago) {
      mercadoPago['publicKey'] = String(mercadoPago['publicKey'] || '').trim();
      mercadoPago['accessToken'] = String(mercadoPago['accessToken'] || '').trim();
      // Webhook SIEMPRE canónico del entorno real de ecommerce (los hosts por-shard vtx-*.cloudfunctions.net
      // no tienen funciones; apuntar ahí = pagos nunca confirmados = sin mails ni stock).
      const platformEnvIsProd = (process.env.GCLOUD_PROJECT || '').includes('vertex-platform-app');
      mercadoPago['webhookUrl'] = platformEnvIsProd
        ? 'https://us-central1-ecommerce-vertex.cloudfunctions.net/mercadoPagoWebhookHandler'
        : 'https://us-central1-ecommerce-vertex-dev.cloudfunctions.net/mercadoPagoWebhookHandler';
    }

    const db = getFirestore();
    const storeSnap = await db.collection('stores').doc(storeId).get();
    if (!storeSnap.exists) throw new HttpsError('not-found', 'Store not found.');

    const store = storeSnap.data() as {
      firebaseProjectId?: string;
      runtimeProjectId?: string;
      runtimeMode?: string;
      tenantId?: string;
      slug?: string;
    };
    const projectId = resolveRuntimeProjectId(store);
    // El storeId del doc singleton es el tenantId (slug), el identificador del storefront
    const storeTenantId = store.slug || store.tenantId || storeId;
    const configPath = `configuracion/store_${storeTenantId}`;
    const auth = await getOwnerOAuthClient();

    if (mercadoPago) {
      // Captura fuera del scope interno para el mirror en store_payments del shard.
      let mpValidationInfo: { accountEmail: string; accountUserId: string } = {
        accountEmail: '',
        accountUserId: '',
      };
      let perStoreSecretName = '';
      if (mercadoPago['accessToken']) {
        const validation = await validateMercadoPagoCredentials(
          mercadoPago['accessToken'],
          mercadoPago['webhookUrl'],
        );
        perStoreSecretName = `mp-access-token-${storeTenantId}`;
        try {
          await upsertSecretInProject(
            auth,
            projectId,
            perStoreSecretName,
            mercadoPago['accessToken'],
          );
        } catch (secretErr) {
          // El secreto en Secret Manager es la vía preferida; si el IAM del SA no lo permite,
          // el token REAL se persiste igual en Firestore del shard (store_payments) para que
          // el resolver del storefront nunca caiga al master TEST ("una de las partes es de prueba").
          console.warn(
            `[MP] No se pudo escribir secreto ${perStoreSecretName} en shard ${projectId}:`,
            secretErr,
          );
        }

        mercadoPago['accessTokenSecret'] = perStoreSecretName;
        mercadoPago['accessTokenMasked'] = maskToken(mercadoPago['accessToken']);
        mercadoPago['accountEmail'] = validation.accountEmail || '';
        mercadoPago['accountUserId'] = validation.userId || '';
        mercadoPago['validationStatus'] = 'valid';
        mercadoPago['validationMessage'] = validation.message;
        mercadoPago['validatedAt'] = new Date().toISOString();
        mpValidationInfo = {
          accountEmail: validation.accountEmail || '',
          accountUserId: validation.userId || '',
        };
      } else if (mercadoPago['accessTokenSecret']) {
        mercadoPago['validationStatus'] = mercadoPago['validationStatus'] || 'valid';
        mercadoPago['validationMessage'] =
          mercadoPago['validationMessage'] || 'Token almacenado en Secret Manager.';
      } else {
        mercadoPago['validationStatus'] = 'pending';
        mercadoPago['validationMessage'] = 'Sin token configurado.';
      }

      // Path canónico de lectura del storefront: store_payments/{tenantId}.payments.mercadoPago
      // con el token REAL en claro, para que el resolver NUNCA caiga al master TEST aunque el
      // secreto del shard no sea legible por el Service Account del storefront (IAM).
      try {
        const paymentsPath = `store_payments/${storeTenantId}`;
        const paymentsPayload: Record<string, any> = {
          mercadoPago: {
            publicKey: mercadoPago['publicKey'] || '',
            accessToken: mercadoPago['accessToken'],
            accessTokenSecret: perStoreSecretName,
            webhookUrl: mercadoPago['webhookUrl'] || '',
            accountEmail: mpValidationInfo.accountEmail,
            accountUserId: mpValidationInfo.accountUserId,
            validationStatus: 'valid',
            sandbox: false,
            updatedAt: new Date().toISOString(),
          },
        };
        const paymentsFields = toFirestoreFieldsForPayments(paymentsPayload);
        await retry(
          () =>
            apiFetch(
              auth,
              `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${paymentsPath}`,
              {
                method: 'PATCH',
                body: { fields: paymentsFields },
                quotaProject: projectId,
              },
            ),
          5,
          6000,
        );
      } catch (paymentsErr) {
        console.warn(
          `[MP] No se pudo escribir store_payments/${storeTenantId} en shard ${projectId}:`,
          paymentsErr,
        );
      }

      delete mercadoPago['accessToken'];
    }

    const { toFirestoreFields } = require('./seeds');

    let existingFields: Record<string, any> = {};
    try {
      const existingDoc = (await apiFetch(
        auth,
        `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${configPath}`,
        { quotaProject: projectId },
      )) as { fields?: Record<string, any> };
      existingFields = existingDoc.fields || {};
    } catch (err) {
      console.warn(`storeConfig did not exist for ${projectId}, creating new.`, err);
    }

    const incomingFields = toFirestoreFields(configToSave).fields;
    const mergedFields = { ...existingFields, ...incomingFields };

    await retry(
      () =>
        apiFetch(
          auth,
          `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${configPath}`,
          {
            method: 'PATCH',
            body: { fields: mergedFields },
            quotaProject: projectId,
          },
        ),
      5,
      6000,
    );

    const centralUpdates: Record<string, any> = { updatedAt: new Date() };
    if (configToSave.storeName) centralUpdates.name = configToSave.storeName;
    if (configToSave.logoUrl !== undefined) centralUpdates.logoUrl = configToSave.logoUrl;
    await db.collection('stores').doc(storeId).update(centralUpdates);

    return { success: true };
  },
);

export const getStoreConfig = onCall<{ storeId: string }>(
  { cors: ALLOWED_ORIGINS, invoker: 'public' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError('permission-denied', 'Only platform admins can view store configs.');
    }

    const { storeId } = request.data;
    if (!storeId) {
      throw new HttpsError('invalid-argument', 'storeId is required.');
    }

    const db = getFirestore();
    const storeSnap = await db.collection('stores').doc(storeId).get();
    if (!storeSnap.exists) throw new HttpsError('not-found', 'Store not found.');

    const store = storeSnap.data() as {
      firebaseProjectId?: string;
      runtimeProjectId?: string;
      runtimeMode?: string;
      tenantId?: string;
      slug?: string;
    };
    const projectId = resolveRuntimeProjectId(store);
    const storeTenantId = store.slug || store.tenantId || storeId;
    const configPath = `configuracion/store_${storeTenantId}`;
    const auth = await getOwnerOAuthClient();

    try {
      const existingDoc = (await apiFetch(
        auth,
        `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${configPath}`,
        { quotaProject: projectId },
      )) as { fields?: Record<string, any> };

      const parseValue = (val: any): any => {
        if (!val) return null;
        if ('stringValue' in val) return val.stringValue;
        if ('doubleValue' in val) return Number(val.doubleValue);
        if ('integerValue' in val) return Number(val.integerValue);
        if ('booleanValue' in val) return val.booleanValue;
        if ('timestampValue' in val) return val.timestampValue;
        if ('arrayValue' in val) {
          const vals = val.arrayValue?.values || [];
          return vals.map((v: any) => parseValue(v));
        }
        if ('mapValue' in val) {
          const fields = val.mapValue?.fields || {};
          const obj: Record<string, any> = {};
          for (const [k, v] of Object.entries(fields)) {
            obj[k] = parseValue(v);
          }
          return obj;
        }
        if ('nullValue' in val) return null;
        return null;
      };

      const fields = existingDoc.fields || {};
      const config: Record<string, any> = {};
      for (const [k, v] of Object.entries(fields)) {
        config[k] = parseValue(v);
      }
      return { config };
    } catch (err) {
      console.warn(`storeConfig did not exist for ${projectId}`, err);
      return { config: null };
    }
  },
);

export const inviteStaff = onCall<InviteStaffPayload>(
  { cors: ALLOWED_ORIGINS, invoker: 'public' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError('permission-denied', 'Only platform admins can invite staff.');
    }

    await checkRateLimit(request.auth?.uid, 'inviteStaff', 15, 15);

    const { storeId, email, role } = request.data;
    if (!storeId || !email || !role) {
      throw new HttpsError('invalid-argument', 'storeId, email, and role are required.');
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedRole = role.trim().toLowerCase();
    const allowedRoles = new Set(['admin', 'staff']);
    if (!allowedRoles.has(normalizedRole)) {
      throw new HttpsError('invalid-argument', 'Invalid role for staff invitation.');
    }

    const db = getFirestore();
    const storeSnap = await db.collection('stores').doc(storeId).get();
    if (!storeSnap.exists) throw new HttpsError('not-found', 'Store not found.');

    const store = storeSnap.data() as {
      firebaseProjectId?: string;
      runtimeProjectId?: string;
      runtimeSiteId?: string;
      runtimeMode?: string;
      name?: string;
      tenantId?: string;
      slug?: string;
    };
    const projectId = resolveRuntimeProjectId(store);
    const storeName = store.name || storeId;
    const tenantId = store.tenantId || store.slug || storeId;
    const loginUrl = store.runtimeSiteId
      ? `https://${store.runtimeSiteId}.web.app/admin/login`
      : `https://${projectId}.web.app/admin/login`;

    const token = crypto.randomUUID();
    // UPSERT: si ya existe una invitación pendiente para este email, se actualiza
    // (nuevo token + fecha refrescada) en vez de duplicar la fila — "reenviar" ≠ "duplicar".
    const existingSnap = await db
      .collection('stores')
      .doc(storeId)
      .collection('invitations')
      .where('email', '==', normalizedEmail)
      .where('status', '==', 'pending')
      .limit(1)
      .get();

    let invitationId: string;
    const now = new Date();
    if (!existingSnap.empty) {
      invitationId = existingSnap.docs[0].id;
      await db
        .collection('stores')
        .doc(storeId)
        .collection('invitations')
        .doc(invitationId)
        .update({
          role: normalizedRole,
          token,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        });
      console.info(
        `[inviteStaff] Invitación existente reenviada (${normalizedEmail}) — sin duplicar.`,
      );
    } else {
      invitationId = crypto.randomUUID();
      await db.collection('stores').doc(storeId).collection('invitations').doc(invitationId).set({
        id: invitationId,
        email: normalizedEmail,
        role: normalizedRole,
        token,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
    }

    let auth: any;
    if (process.env.FUNCTIONS_EMULATOR === 'true') {
      const compositeKey = `${tenantId}_${normalizedEmail}`;
      await db.collection('admin_roles').doc(compositeKey).set({
        role: normalizedRole,
        tenantId: tenantId,
        source: 'vertex-platform-invite',
        updatedAt: new Date(),
      });
      const mockUid = `mock-uid-${normalizedEmail.replace(/[^a-zA-Z0-9]/g, '-')}`;
      await db.collection('users').doc(mockUid).set({
        email: normalizedEmail,
        role: normalizedRole,
        displayName: 'Invited Staff (Mock)',
        joinedAt: new Date(),
      });
    } else {
      try {
        auth = await getOwnerOAuthClient();
      } catch (err) {
        console.error('[inviteStaff] Failed to load GCP owner credentials.', err);
        throw new HttpsError(
          'failed-precondition',
          'No se pudo enviar la invitación real porque faltan credenciales de aprovisionamiento.',
        );
      }

      try {
        const encodedEmail = encodeURIComponent(normalizedEmail);
        const compositeKey = `${tenantId}_${encodedEmail}`;
        await apiFetch(
          auth,
          `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/admin_roles/${compositeKey}`,
          {
            method: 'PATCH',
            body: {
              fields: {
                role: { stringValue: normalizedRole },
                tenantId: { stringValue: tenantId },
                source: { stringValue: 'vertex-platform-invite' },
                updatedAt: { timestampValue: new Date().toISOString() },
              },
            },
            quotaProject: projectId,
          },
        );
      } catch (err) {
        console.error(`[inviteStaff] Failed to write admin_roles in ${projectId}:`, err);
        throw new HttpsError(
          'internal',
          'No se pudo preautorizar el correo en la tienda destino para OAuth de Google.',
        );
      }
    }

    let inviteEmailSent = true;
    try {
      const displayRole = normalizedRole === 'staff' ? 'Operador / Staff' : 'Administrador';
      const emailSubject = `Acceso de ${displayRole.toLowerCase()} habilitado para ${storeName} - Vertex`;
      const emailHtml = `
        <div style="background:#f1f5f9;padding:28px 16px;font-family:Arial,sans-serif;color:#0f172a;">
          <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:14px;border:1px solid #e2e8f0;overflow:hidden;">
            <div style="padding:20px 24px;background:linear-gradient(120deg,#0f172a,#1d4ed8);color:#ffffff;">
              <p style="margin:0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;">Vertex Platform</p>
              <h1 style="margin:8px 0 0;font-size:22px;line-height:1.25;">Tu acceso está listo</h1>
            </div>
            <div style="padding:24px;">
              <p style="margin:0 0 14px;color:#0f172a;font-size:15px;line-height:1.55;">
                Se te otorgó acceso de ${displayRole.toLowerCase()} para la tienda <strong>${storeName}</strong>.
              </p>
              <p style="margin:0 0 18px;color:#334155;font-size:14px;">Rol asignado: <strong>${displayRole}</strong></p>
              <p style="margin:0 0 14px;color:#334155;font-size:14px;line-height:1.5;">
                Ingresá con tu cuenta de Google usando esta misma dirección de email.
              </p>
              <p style="margin:0 0 22px;">
                <a href="${loginUrl}" style="display:inline-block;padding:12px 18px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700;">Ingresar al panel</a>
              </p>
              <p style="margin:0 0 10px;color:#64748b;font-size:12px;line-height:1.45;">
                Si el botón no funciona, copiá y pegá el siguiente enlace en tu navegador:
              </p>
              <p style="margin:0;color:#1d4ed8;font-size:12px;word-break:break-all;">${loginUrl}</p>
            </div>
          </div>
        </div>
      `;

      try {
        if (process.env.FUNCTIONS_EMULATOR === 'true') {
          await db
            .collection('tenants')
            .doc(tenantId)
            .collection('mail')
            .add({
              to: [normalizedEmail],
              message: {
                subject: emailSubject,
                html: emailHtml,
                text: `Tenés acceso de administrador para la tienda ${storeName}. Ingresá con Google OAuth: ${loginUrl}`,
              },
              createdAt: new Date(),
            });
          console.info(
            `[inviteStaff] Staff invitation email successfully written to emulator storefront tenant mail collection.`,
          );
        } else {
          // Enviar el mail de invitación DIRECTAMENTE desde el platform (SMTP en Secret
          // Manager) — funciona para TODAS las tiendas, incluidas las de shards.
          try {
            await sendDirectEmail(
              normalizedEmail,
              emailSubject,
              emailHtml,
              `Tenés acceso de administrador para la tienda ${storeName}. Ingresá con Google OAuth: ${loginUrl}`,
            );
            console.info(
              `[inviteStaff] Staff invitation email successfully sent directly to ${normalizedEmail} using SMTP.`,
            );
          } catch (directErr) {
            console.warn(
              `[inviteStaff] Direct SMTP send failed, queueing in store ${projectId}'s mail collection:`,
              directErr,
            );
            const mailDocFields = {
              to: { arrayValue: { values: [{ stringValue: normalizedEmail }] } },
              message: {
                mapValue: {
                  fields: {
                    subject: { stringValue: emailSubject },
                    html: { stringValue: emailHtml },
                    text: {
                      stringValue: `Tenés acceso de administrador para la tienda ${storeName}. Ingresá con Google OAuth: ${loginUrl}`,
                    },
                  },
                },
              },
              createdAt: { timestampValue: new Date().toISOString() },
            };
            await apiFetch(
              auth,
              `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/mail`,
              { method: 'POST', body: { fields: mailDocFields }, quotaProject: projectId },
            );
            console.info(
              `[inviteStaff] Staff invitation email successfully queued in store ${projectId}'s mail collection.`,
            );
          }
        }
      } catch (mailErr) {
        console.warn(
          `[inviteStaff] Failed to queue invitation email in store ${projectId}'s mail collection, falling back to central mail queue:`,
          mailErr,
        );
        // Fallback to central platform mail collection
        await db.collection('mail').add({
          to: [normalizedEmail],
          message: {
            subject: emailSubject,
            html: emailHtml,
            text: `Tenés acceso de administrador para la tienda ${storeName}. Ingresá con Google OAuth: ${loginUrl}`,
          },
        });
      }

      await db
        .collection('stores')
        .doc(storeId)
        .collection('invitations')
        .doc(invitationId)
        .update({
          inviteEmailSentAt: new Date(),
          updatedAt: new Date(),
        });
    } catch (err) {
      inviteEmailSent = false;
      console.error('[inviteStaff] Failed to dispatch invitation email.', err);
      await db
        .collection('stores')
        .doc(storeId)
        .collection('invitations')
        .doc(invitationId)
        .update({
          inviteEmailErrorAt: new Date(),
          updatedAt: new Date(),
        });
    }

    await logAuditAction(
      request.auth?.uid || 'unknown',
      request.auth?.token.email as string | undefined,
      'inviteStaff',
      storeId,
      'success',
      { email: normalizedEmail, role: normalizedRole, inviteEmailSent },
    );

    return { success: true, token, inviteEmailSent };
  },
);

export const getStoreStaff = onCall<{ storeId: string }>(
  { cors: ALLOWED_ORIGINS, invoker: 'public' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError('permission-denied', 'Only platform admins can view store staff.');
    }

    const { storeId } = request.data;
    if (!storeId) {
      throw new HttpsError('invalid-argument', 'storeId is required.');
    }

    const db = getFirestore();
    const storeSnap = await db.collection('stores').doc(storeId).get();
    if (!storeSnap.exists) throw new HttpsError('not-found', 'Store not found.');

    const store = storeSnap.data() as {
      ownerEmail?: string;
      clientEmail?: string;
      name?: string;
      slug?: string;
      createdAt?: any;
      firebaseProjectId?: string;
      runtimeProjectId?: string;
      provisioningOwnerId?: string;
    };
    const projectId = resolveRuntimeProjectId(store);
    const tenantId = store.slug || storeId;

    const users: Array<{
      uid: string;
      email: string;
      role: string;
      displayName?: string;
      joinedAt?: string;
      isOwner?: boolean;
    }> = [];

    // 1. Incluir siempre al Dueño de la Tienda como miembro principal
    const ownerEmail = (store.ownerEmail || store.clientEmail || '').trim();
    if (ownerEmail) {
      users.push({
        uid: `owner-${store.slug || storeId}`,
        email: ownerEmail,
        role: 'owner',
        displayName: store.name ? store.name : 'Titular de la cuenta',
        joinedAt:
          store.createdAt instanceof Date
            ? store.createdAt.toISOString()
            : store.createdAt?.toDate?.()?.toISOString?.() || new Date().toISOString(),
        isOwner: true,
      });
    }

    // 2. Consultar subcolección stores/{storeId}/staff en Platform Firestore
    try {
      const staffSnap = await db.collection('stores').doc(storeId).collection('staff').get();
      for (const doc of staffSnap.docs) {
        const data = doc.data();
        const email = (data['email'] || '').trim();
        if (email && !users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
          users.push({
            uid: doc.id,
            email,
            role: data['role'] || 'admin',
            displayName: data['displayName'] || data['name'] || '',
            joinedAt:
              data['createdAt'] instanceof Date
                ? data['createdAt'].toISOString()
                : data['createdAt']?.toDate?.()?.toISOString?.() || '',
          });
        }
      }
    } catch (err) {
      console.warn(`[getStoreStaff] Failed to load local staff subcollection:`, err);
    }

    // 3. Consultar colección admin_roles en el shard Firestore
    if (projectId) {
      try {
        const shardDb = getFirestoreForProject(projectId);
        const adminRolesSnap = await shardDb.collection('admin_roles').get();
        for (const doc of adminRolesSnap.docs) {
          const data = doc.data();
          const docTenant = data['tenantId'] || data['storeId'] || '';
          const matchesTenant =
            docTenant === tenantId ||
            docTenant === storeId ||
            doc.id.startsWith(`${tenantId}_`) ||
            doc.id.startsWith(`${storeId}_`);

          if (matchesTenant) {
            let email = (data['email'] || '').trim();
            if (!email && doc.id.includes('_')) {
              const rawEmailPart = doc.id.substring(doc.id.indexOf('_') + 1);
              try {
                email = decodeURIComponent(rawEmailPart);
              } catch {
                email = rawEmailPart;
              }
            }
            if (email && !users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
              users.push({
                uid: doc.id,
                email,
                role: data['role'] || 'admin',
                displayName: data['displayName'] || '',
                joinedAt:
                  data['assignedAt'] instanceof Date
                    ? data['assignedAt'].toISOString()
                    : data['assignedAt']?.toDate?.()?.toISOString?.() ||
                      data['updatedAt']?.toDate?.()?.toISOString?.() ||
                      '',
              });
            }
          }
        }
      } catch (err) {
        console.warn(`[getStoreStaff] Failed to load shard admin_roles:`, err);
      }
    }

    let invitations: any[] = [];
    try {
      const invitationsSnap = await db
        .collection('stores')
        .doc(storeId)
        .collection('invitations')
        .get();
      invitations = invitationsSnap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          email: data['email'],
          role: data['role'],
          status: data['status'],
          createdAt: data['createdAt']?.toDate?.()?.toISOString?.() || '',
        };
      });

      // Una invitación recién enviada queda PENDIENTE. Solo se considera ACEPTADA cuando el
      // invitado inició sesión en la cuenta de la tienda DESPUÉS de la invitación
      // (lastLoginAt >= createdAt). Que el rol esté pre-creado o que la cuenta exista en el
      // shard NO significa que aceptó: eso producía "Aceptada" al instante de invitar.
      const pending = invitations.filter((i: any) => i.status === 'pending');
      for (const inv of pending) {
        if (!projectId) continue;
        const inviteMs = inv.createdAt ? Date.parse(String(inv.createdAt)) : 0;
        if (!inviteMs) continue; // sin fecha no hay forma de verificar aceptación real
        try {
          const ownerAuth = await getOwnerOAuthClient(store.provisioningOwnerId);
          const ownerToken = (await ownerAuth.getAccessToken()).token;
          const lookup = await fetch(
            `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:lookup`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${ownerToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ email: [inv.email] }),
            },
          );
          if (lookup.ok) {
            const body = (await lookup.json()) as {
              users?: Array<{ lastLoginAt?: string }>;
            };
            const lastLoginMs = Number((body.users || [])[0]?.lastLoginAt || 0);
            const accepted = Number.isFinite(lastLoginMs) && lastLoginMs >= inviteMs;
            if (accepted) {
              inv.status = 'accepted';
              await db
                .collection('stores')
                .doc(storeId)
                .collection('invitations')
                .doc(inv.id)
                .update({ status: 'accepted', acceptedAt: new Date() })
                .catch(() => {});
            } else {
              inv.status = 'pending'; // sin login posterior a la invitación => sigue pendiente
            }
          }
        } catch (lookupErr) {
          console.warn(
            `[getStoreStaff] No se pudo verificar aceptación real de ${inv.email} en ${projectId}:`,
            lookupErr,
          );
        }
      }
    } catch (err) {
      console.error(`[getStoreStaff] Failed to load local invitations from Firestore:`, err);
    }

    return { users, staff: users, invitations };
  },
);

export const verifyDomainDNSStatus = onCall<{ storeId: string; domain: string }>(
  { cors: ALLOWED_ORIGINS, invoker: 'public' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError('permission-denied', 'Only platform admins can verify domains.');
    }

    const { storeId, domain } = request.data;
    if (!storeId || !/^[a-zA-Z0-9_-]{1,100}$/.test(storeId)) {
      throw new HttpsError('invalid-argument', 'Invalid storeId.');
    }
    if (
      !domain ||
      !/^(?!.*\.\.)(?!.*\.$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(
        domain,
      )
    ) {
      throw new HttpsError('invalid-argument', 'Invalid domain format.');
    }

    const db = getFirestore();
    const storeSnap = await db.collection('stores').doc(storeId).get();
    if (!storeSnap.exists) throw new HttpsError('not-found', 'Store not found.');

    const store = storeSnap.data() as {
      firebaseProjectId?: string;
      runtimeProjectId?: string;
      runtimeSiteId?: string;
      ownerEmail?: string;
      provisioningOwnerId?: string;
    };

    const authEmail = request.auth?.token.email as string | undefined;
    if (!isOwnerOrSuperAdmin(authEmail, store.ownerEmail)) {
      throw new HttpsError('permission-denied', 'You do not have permission to manage this store.');
    }

    if (process.env.FUNCTIONS_EMULATOR === 'true') {
      const dnsRecords = [
        { domainName: domain, type: 'A', rdata: '199.36.158.100', requiredAction: 'ADD' },
        {
          domainName: `www.${domain}`,
          type: 'CNAME',
          rdata: `${storeId}.web.app`,
          requiredAction: 'ADD',
        },
      ];
      return { success: true, status: 'live', dnsRecords };
    }

    const projectId = resolveRuntimeProjectId(store);
    if (!projectId) {
      throw new HttpsError('failed-precondition', 'Store has no associated Firebase project.');
    }
    const siteId = resolveRuntimeSiteId(store);
    const auth = await getOwnerOAuthClient(store.provisioningOwnerId);

    let result: {
      status?: string;
      provisioning?: {
        expectedIps?: string[];
        dnsStatus?: string;
        certStatus?: string;
      };
      requiredDnsUpdates?: {
        discovered?: Array<{
          domainName?: string;
          type?: string;
          rdata?: string;
          requiredAction?: string;
        }>;
      };
    } = {};

    try {
      const tokenRes = await auth.getAccessToken();
      const res = await fetch(
        `https://firebasehosting.googleapis.com/v1beta1/projects/${projectId}/sites/${siteId}/domains/${domain}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${tokenRes.token}`,
            'Content-Type': 'application/json',
          },
        },
      );

      if (!res.ok) {
        const text = await res.text();
        console.warn('verifyDomainDNSStatus Firebase Hosting warning/error:', res.status, text);
      } else {
        result = (await res.json()) as typeof result;
      }
    } catch (fetchErr) {
      console.warn('verifyDomainDNSStatus fetch error:', fetchErr);
    }

    // El estado real de "live" lo dan los campos de provisioning:
    //  - dnsStatus: DNS_READY / DNS_ACTIVE → registros apuntando bien
    //  - certStatus: CERT_ACTIVE → certificado SSL emitido
    // (el campo status de la API siempre es DOMAIN_ACTIVE una vez creado el mapping).
    const provisioning = result.provisioning ?? {};
    const dnsReady =
      provisioning.dnsStatus === 'DNS_READY' ||
      provisioning.dnsStatus === 'DNS_ACTIVE' ||
      provisioning.dnsStatus === 'ACTIVE';
    const certReady =
      provisioning.certStatus === 'CERT_ACTIVE' || provisioning.certStatus === 'ACTIVE';
    const normalizedStatus = dnsReady && certReady ? 'live' : 'pending';
    // La API NO incluye requiredDnsUpdates en el GET; los registros estándar salen de
    // provisioning.expectedIps (A) + CNAME www → {site}.web.app.
    const discovered = result.requiredDnsUpdates?.discovered ?? [];
    const expectedIps = result.provisioning?.expectedIps ?? ['199.36.158.100'];
    const isSubdomain = domain.split('.').length > 2;
    const dnsRecords =
      discovered.length > 0
        ? discovered.map((record) => ({
            domainName: record.domainName || '@',
            type: record.type || 'A',
            rdata: record.rdata || '',
            requiredAction: record.requiredAction || 'ADD',
          }))
        : [
            {
              domainName: isSubdomain ? domain.split('.')[0] : '@',
              type: 'A',
              rdata: expectedIps[0] || '199.36.158.100',
              requiredAction: 'ADD',
            },
            {
              domainName: 'www',
              type: 'CNAME',
              rdata: `${siteId}.web.app`,
              requiredAction: 'ADD',
            },
          ];

    await logAuditAction(
      request.auth?.uid || 'unknown',
      authEmail,
      'verifyDomainDNSStatus',
      storeId,
      'success',
      { domain, status: normalizedStatus },
    );

    return { success: true, status: normalizedStatus, dnsRecords };
  },
);

export const seedStore = onCall<{
  storeId: string;
  includeMockData?: boolean;
  provisioningMode?: string;
  verticalId?: string;
}>(
  { cors: ALLOWED_ORIGINS, invoker: 'public', timeoutSeconds: 300, memory: '512MiB' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError('permission-denied', 'Only platform admins can seed store data.');
    }

    const {
      storeId,
      includeMockData = true,
      provisioningMode = 'FULL_DEMO',
      verticalId: reqVerticalId,
    } = request.data;
    if (!storeId) {
      throw new HttpsError('invalid-argument', 'storeId is required.');
    }

    const db = getFirestore();
    const storeSnap = await db.collection('stores').doc(storeId).get();
    if (!storeSnap.exists) throw new HttpsError('not-found', 'Store not found.');

    const store = storeSnap.data() as {
      name: string;
      slug: string;
      firebaseProjectId?: string;
      runtimeProjectId?: string;
      verticalId?: string;
    };
    const projectId = resolveRuntimeProjectId(store);
    const fallbackProjectId =
      store.firebaseProjectId && store.firebaseProjectId !== projectId
        ? store.firebaseProjectId
        : null;
    const verticalId = reqVerticalId || store.verticalId || 'TECNOLOGIA_ELECTRONICA';
    const tenantId = store.slug;

    const auth = await getOwnerOAuthClient();
    const { seedStoreData } = require('./seeds');

    try {
      await seedStoreData(
        auth,
        projectId,
        tenantId,
        verticalId,
        store.name,
        includeMockData !== false,
        true,
        storeId,
        provisioningMode,
      );
      return { success: true };
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      const shouldRetryWithFallback =
        !!fallbackProjectId &&
        (message.toLowerCase().includes('permission denied') ||
          message.toLowerCase().includes('service_disabled') ||
          message.toLowerCase().includes('consumer_invalid'));

      if (shouldRetryWithFallback) {
        try {
          await seedStoreData(
            auth,
            fallbackProjectId,
            tenantId,
            verticalId,
            store.name,
            includeMockData !== false,
            true,
            storeId,
            provisioningMode,
          );
          await db.collection('stores').doc(storeId).update({
            runtimeProjectId: fallbackProjectId,
            updatedAt: new Date(),
          });
          return { success: true, warning: `runtimeProjectId updated to ${fallbackProjectId}` };
        } catch (fallbackErr) {
          console.error(
            `Error seeding store ${storeId} (fallback project: ${fallbackProjectId}):`,
            fallbackErr,
          );
        }
      }

      console.error(`Error seeding store ${storeId} (project: ${projectId}):`, err);
      const msg = err instanceof Error ? err.message : String(err);
      throw new HttpsError('internal', `Failed to seed store data: ${msg}`);
    }
  },
);

export const listBusinessVerticals = onCall(
  { cors: ALLOWED_ORIGINS, invoker: 'public' },
  async () => {
    const { getAllBusinessVerticalsSummary } = require('./verticals/verticals.registry');
    const builtIn = getAllBusinessVerticalsSummary();
    try {
      const db = getFirestore();
      const customSnap = await db.collection('business_verticals').get();
      const custom = customSnap.docs.map((docSnap) => {
        const data = docSnap.data();
        return {
          id: docSnap.id,
          name: data['name'] || docSnap.id,
          icon: data['icon'] || '🏷️',
          description: data['description'] || '',
          isCustom: true,
          categories: data['categories'] || [],
          themeColors: data['themeColors'],
        };
      });
      return { verticals: [...builtIn, ...custom] };
    } catch {
      return { verticals: builtIn };
    }
  },
);

export const createCustomVertical = onCall(
  { cors: ALLOWED_ORIGINS, invoker: 'public' },
  async (request) => {
    if (!request.auth?.token['platformAdmin']) {
      throw new HttpsError(
        'permission-denied',
        'Only platform admins can create custom business verticals.',
      );
    }
    const data = (request.data || {}) as Record<string, unknown>;
    const name = String(data['name'] || '').trim();
    if (!name) {
      throw new HttpsError('invalid-argument', 'El nombre del rubro es requerido.');
    }

    const rawSlug = String(data['slug'] || name)
      .toLowerCase()
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/(^_|_$)/g, '');

    const id = rawSlug.toUpperCase() || `CUSTOM_${Date.now()}`;
    const icon = String(data['icon'] || '🏷️').trim() || '🏷️';
    const description = String(data['description'] || '').trim();
    const categories = Array.isArray(data['categories']) ? data['categories'] : [];
    const attributes = Array.isArray(data['attributes']) ? data['attributes'] : [];
    const themeColors = data['themeColors'] || {
      primary: '#6366f1',
      accent: '#06b6d4',
      background: '#0f172a',
    };
    const bannerTitle = String(data['bannerTitle'] || `¡Bienvenidos a ${name}!`).trim();
    const bannerSubtitle = String(
      data['bannerSubtitle'] || 'Descubrí nuestras colecciones y novedades exclusivas.',
    ).trim();

    const db = getFirestore();
    const verticalDocRef = db.collection('business_verticals').doc(id);
    const existing = await verticalDocRef.get();
    if (existing.exists) {
      throw new HttpsError(
        'already-exists',
        `Ya existe un rubro registrado con el identificador ${id}.`,
      );
    }

    const customVerticalRecord = {
      id,
      name,
      icon,
      description,
      isCustom: true,
      categories,
      attributes,
      themeColors,
      bannerTitle,
      bannerSubtitle,
      createdBy: request.auth.token['email'] || request.auth.uid,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await verticalDocRef.set(customVerticalRecord);
    return { success: true, vertical: customVerticalRecord };
  },
);
