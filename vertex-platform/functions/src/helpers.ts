import * as crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { OAuth2Client, GoogleAuth } from 'google-auth-library';
import * as nodemailer from 'nodemailer';

export async function getPlatformServiceAccountOAuthClient(): Promise<OAuth2Client> {
  const googleAuth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = (await googleAuth.getClient()) as OAuth2Client;
  return client;
}

interface OwnerCredentialsSecret {
  id?: string;
  label?: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  maxProjects?: number;
}

export interface ProvisioningOwnerCredentials {
  id: string;
  label?: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  maxProjects?: number;
}

export const PLATFORM_PROJECT = (() => {
  const p =
    process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? 'vertex-platform-app';
  return p === 'demo-vertex' ? 'vertex-platform-dev' : p;
})();

export const ALLOWED_ORIGINS: (string | RegExp)[] = [
  'https://vertex-platform-app.web.app',
  'https://vertex-platform-app.firebaseapp.com',
  'https://vertex-platform-dev.web.app',
  'https://vertex-platform-dev.firebaseapp.com',
  'https://vertex-platform.web.app',
  'https://vertex-platform.firebaseapp.com',
  'http://localhost:4200',
  'http://127.0.0.1:4200',
  /^https:\/\/vertex-platform-dev--pr-[a-zA-Z0-9-]+\.web\.app$/,
  /^https:\/\/vertex-platform-dev--pr-[a-zA-Z0-9-]+\.firebaseapp\.com$/,
  /^https:\/\/vertex-platform-app--pr-[a-zA-Z0-9-]+\.web\.app$/,
  /^https:\/\/vertex-platform-app--pr-[a-zA-Z0-9-]+\.firebaseapp\.com$/,
];

let cachedGitHubPat: string | null = null;
let cachedOwnerCreds: { client_id: string; client_secret: string; refresh_token: string } | null =
  null;
let cachedOwnerPool: ProvisioningOwnerCredentials[] | null = null;
export const secretsClient = new SecretManagerServiceClient();

export const DEFAULT_SANDBOX_PUBLIC_KEY =
  process.env.DEFAULT_SANDBOX_PUBLIC_KEY || 'TEST-a354ba2d-3a48-441b-8d83-0179ef8f14eb';
export const DEFAULT_SANDBOX_ACCESS_TOKEN =
  process.env.DEFAULT_SANDBOX_ACCESS_TOKEN ||
  'TEST-151675204666-090317-defaultsandboxsampletoken-123456';

function isMissingSecretError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('404') || msg.toLowerCase().includes('not found');
}

function normalizeOwnerCredential(
  raw: OwnerCredentialsSecret,
  index: number,
): ProvisioningOwnerCredentials {
  return {
    id: raw.id?.trim() || `owner-${index + 1}`,
    label: raw.label?.trim(),
    client_id: raw.client_id,
    client_secret: raw.client_secret,
    refresh_token: raw.refresh_token,
    maxProjects: typeof raw.maxProjects === 'number' ? raw.maxProjects : undefined,
  };
}

async function loadOwnerCredentialPool(): Promise<ProvisioningOwnerCredentials[]> {
  if (cachedOwnerPool) return cachedOwnerPool;

  try {
    const [version] = await secretsClient.accessSecretVersion({
      name: `projects/${PLATFORM_PROJECT}/secrets/platform-owner-credentials-pool/versions/latest`,
    });
    const parsed = JSON.parse(version.payload!.data!.toString()) as
      | OwnerCredentialsSecret[]
      | { owners?: OwnerCredentialsSecret[] };
    const rawOwners = Array.isArray(parsed) ? parsed : parsed.owners;
    if (!Array.isArray(rawOwners) || rawOwners.length === 0) {
      throw new Error(
        'Secret platform-owner-credentials-pool must contain a non-empty array of owner credentials.',
      );
    }
    cachedOwnerPool = rawOwners.map((owner, index) => normalizeOwnerCredential(owner, index));
    return cachedOwnerPool;
  } catch (err) {
    if (!isMissingSecretError(err)) throw err;
  }

  if (!cachedOwnerCreds) {
    const [version] = await secretsClient.accessSecretVersion({
      name: `projects/${PLATFORM_PROJECT}/secrets/platform-owner-credentials/versions/latest`,
    });
    cachedOwnerCreds = JSON.parse(version.payload!.data!.toString()) as {
      client_id: string;
      client_secret: string;
      refresh_token: string;
    };
  }

  cachedOwnerPool = [
    normalizeOwnerCredential(
      {
        id: 'primary',
        label: 'Primary owner',
        ...cachedOwnerCreds,
      },
      0,
    ),
  ];
  return cachedOwnerPool;
}

export async function getOwnerOAuthClient(ownerId?: string): Promise<OAuth2Client> {
  try {
    const owners = await loadOwnerCredentialPool();
    const owner = ownerId ? owners.find((candidate) => candidate.id === ownerId) : owners[0];
    if (owner && owner.client_id && owner.refresh_token) {
      const oauth2 = new OAuth2Client(owner.client_id, owner.client_secret);
      oauth2.setCredentials({ refresh_token: owner.refresh_token });
      return oauth2;
    }
  } catch (poolErr) {
    console.warn(
      `[getOwnerOAuthClient] Owner credential pool unavailable (${poolErr}). Falling back to platform service account OAuth client...`,
    );
  }

  return getPlatformServiceAccountOAuthClient();
}

export async function listProvisioningOwnerCandidates(
  db: Firestore,
  preferredOwnerId?: string,
): Promise<ProvisioningOwnerCredentials[]> {
  const owners = await loadOwnerCredentialPool();
  const storesSnap = await db
    .collection('stores')
    .where('status', 'in', ['provisioning', 'active', 'suspended'])
    .get();

  const usageMap: Record<string, number> = {};
  storesSnap.docs.forEach((doc) => {
    const ownerId = doc.data()['provisioningOwnerId'] as string | undefined;
    if (ownerId) usageMap[ownerId] = (usageMap[ownerId] ?? 0) + 1;
  });

  const ranked = owners
    .map((owner, index) => {
      const usedProjects = usageMap[owner.id] ?? 0;
      const remainingProjects =
        typeof owner.maxProjects === 'number'
          ? owner.maxProjects - usedProjects
          : Number.POSITIVE_INFINITY;

      return { owner, index, usedProjects, remainingProjects };
    })
    .sort((left, right) => {
      if (preferredOwnerId) {
        if (left.owner.id === preferredOwnerId && right.owner.id !== preferredOwnerId) return -1;
        if (right.owner.id === preferredOwnerId && left.owner.id !== preferredOwnerId) return 1;
      }
      if (left.remainingProjects !== right.remainingProjects) {
        return right.remainingProjects - left.remainingProjects;
      }
      if (left.usedProjects !== right.usedProjects) {
        return left.usedProjects - right.usedProjects;
      }
      return left.index - right.index;
    });

  const available = ranked.filter((candidate) => candidate.remainingProjects > 0);
  if (available.length === 0) {
    throw new Error(
      'All provisioning owner accounts are at capacity. Add another owner credential to platform-owner-credentials-pool or increase the Google Cloud project quota.',
    );
  }

  return available.map((candidate) => candidate.owner);
}
let cachedDeployToken: string | null = null;

const GITHUB_APP_ID = process.env.GITHUB_APP_ID || '5157671';
const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID || '167069206';
let cachedAppToken: { token: string; expiresAt: number } | null = null;
let cachedPrivateKeyPem: string | null = null;

export function _resetGitHubTokenCacheForTesting() {
  cachedAppToken = null;
  cachedPrivateKeyPem = null;
  cachedGitHubPat = null;
  cachedDeployToken = null;
}

export function generateGitHubAppJwt(appId: string, privateKeyPem: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      iat: now - 60,
      exp: now + 600,
      iss: appId,
    }),
  ).toString('base64url');

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKeyPem, 'base64url')}`;
}

export async function getGitHubAppToken(
  appId = GITHUB_APP_ID,
  installationId = GITHUB_APP_INSTALLATION_ID,
): Promise<string | null> {
  const now = Date.now();
  if (cachedAppToken && cachedAppToken.expiresAt > now + 60 * 1000) {
    return cachedAppToken.token;
  }

  try {
    if (!cachedPrivateKeyPem) {
      const [version] = await secretsClient.accessSecretVersion({
        name: `projects/${PLATFORM_PROJECT}/secrets/github-app-key/versions/latest`,
      });
      cachedPrivateKeyPem = version.payload?.data?.toString().trim() || null;
    }

    if (!cachedPrivateKeyPem) return null;

    const jwt = generateGitHubAppJwt(appId, cachedPrivateKeyPem);
    const res = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );

    if (!res.ok) {
      console.warn(`[getGitHubAppToken] Error fetching token (${res.status})`);
      return null;
    }

    const data = (await res.json()) as { token: string; expires_at: string };
    const expiresAt = new Date(data.expires_at).getTime();
    cachedAppToken = { token: data.token, expiresAt };
    return data.token;
  } catch (err) {
    console.warn(
      '[getGitHubAppToken] Error generating GitHub App token, falling back to PAT:',
      err,
    );
    return null;
  }
}

export async function getGitHubPat(): Promise<string> {
  const appToken = await getGitHubAppToken();
  if (appToken) return appToken;

  if (cachedGitHubPat) return cachedGitHubPat;
  const [version] = await secretsClient.accessSecretVersion({
    name: `projects/${PLATFORM_PROJECT}/secrets/github-pat/versions/latest`,
  });
  cachedGitHubPat = version.payload!.data!.toString().trim();
  return cachedGitHubPat;
}

export async function getDeployToken(): Promise<string> {
  if (cachedDeployToken) return cachedDeployToken;
  const [version] = await secretsClient.accessSecretVersion({
    name: `projects/${PLATFORM_PROJECT}/secrets/deploy-token/versions/latest`,
  });
  cachedDeployToken = version.payload!.data!.toString().trim();
  return cachedDeployToken;
}

export interface DeploySequenceMetadata {
  deployNumber: number;
  redeployNumber: number;
  isRedeploy: boolean;
  deployTimestamp: string;
}

export async function calculateDeploySequence(
  db: Firestore,
  storeId: string,
): Promise<DeploySequenceMetadata> {
  let count = 0;
  try {
    const storeRef = db.collection('stores').doc(storeId);
    const storeSnap = await storeRef.get();
    const storeData = storeSnap.exists ? storeSnap.data() : null;

    if (storeData && typeof storeData['deployCount'] === 'number') {
      count = storeData['deployCount'];
    } else {
      // Priorizar subcolección deploy_history, con fallback a deploys
      const historySnap = await storeRef.collection('deploy_history').get();
      if (!historySnap.empty) {
        count = historySnap.size;
      } else {
        const deploysSnap = await storeRef.collection('deploys').get();
        count = deploysSnap.size;
      }
    }
  } catch (err) {
    console.warn(`[calculateDeploySequence] Error reading deploy history for ${storeId}:`, err);
    count = 0;
  }

  const deployTimestamp = new Date().toISOString();
  if (count <= 0) {
    return {
      deployNumber: 1,
      redeployNumber: 0,
      isRedeploy: false,
      deployTimestamp,
    };
  }

  return {
    deployNumber: count + 1,
    redeployNumber: count,
    isRedeploy: true,
    deployTimestamp,
  };
}

export interface RecordDeployHistoryParams {
  db: Firestore;
  storeId: string;
  success: boolean;
  version: string;
  commitSha?: string;
  commitMessage?: string;
  ref?: string;
  error?: string | null;
}

export async function recordStoreDeployHistory(params: RecordDeployHistoryParams): Promise<void> {
  const { db, storeId, success, version, commitSha, commitMessage, ref, error } = params;
  try {
    const storeRef = db.collection('stores').doc(storeId);
    const deploySequence = await calculateDeploySequence(db, storeId);
    const deployLabel =
      deploySequence.isRedeploy && deploySequence.redeployNumber > 0
        ? `Redespliegue ${deploySequence.redeployNumber}`
        : `Despliegue ${deploySequence.deployNumber}`;

    const entry = {
      timestamp: new Date(),
      success,
      commitSha: commitSha || '',
      commitMessage: commitMessage || '',
      ref: ref || '',
      version,
      deployLabel,
      deployNumber: deploySequence.deployNumber,
      redeployNumber: deploySequence.redeployNumber,
      isRedeploy: deploySequence.isRedeploy,
      error: success ? null : error || 'Storefront deployment failed. Check GitHub Action logs.',
    };

    // Registrar en ambas subcolecciones (deploy_history y deploys) para compatibilidad
    await Promise.allSettled([
      storeRef.collection('deploy_history').add(entry),
      storeRef.collection('deploys').add(entry),
      storeRef.update({
        deployCount: deploySequence.deployNumber,
      }),
    ]);
  } catch (err) {
    console.warn(
      `[recordStoreDeployHistory] Non-fatal error recording deploy history for ${storeId}:`,
      err,
    );
  }
}

export async function ensureShardSecurityPolicies(
  targetProjectId: string,
  providedAuth?: OAuth2Client,
): Promise<void> {
  const platformProjectId = PLATFORM_PROJECT;
  const defaultShardProjectId =
    PLATFORM_PROJECT === 'vertex-platform-dev' ? 'ecommerce-vertex-dev' : 'ecommerce-vertex';

  let activeAuth = providedAuth;
  if (!activeAuth) {
    activeAuth = await getPlatformServiceAccountOAuthClient();
  }

  const saList = [
    `${targetProjectId}@appspot.gserviceaccount.com`,
    `${platformProjectId}@appspot.gserviceaccount.com`,
    `${defaultShardProjectId}@appspot.gserviceaccount.com`,
    `firebase-adminsdk-fbsvc@${platformProjectId}.iam.gserviceaccount.com`,
    `firebase-adminsdk-fbsvc@${defaultShardProjectId}.iam.gserviceaccount.com`,
  ];

  try {
    const res = (await apiFetch(
      activeAuth,
      `https://cloudresourcemanager.googleapis.com/v1/projects/${targetProjectId}`,
    )) as { projectNumber?: string } | undefined;
    if (res?.projectNumber) {
      saList.push(`${res.projectNumber}-compute@developer.gserviceaccount.com`);
    }
  } catch (err) {
    console.warn(
      `[ensureShardSecurityPolicies] Failed to fetch projectNumber for ${targetProjectId}:`,
      err,
    );
  }

  const serviceAccounts = Array.from(new Set(saList));

  let policy: { bindings: Array<{ role: string; members: string[] }>; etag: string } | null = null;
  try {
    policy = (await apiFetch(
      activeAuth,
      `https://cloudresourcemanager.googleapis.com/v3/projects/${targetProjectId}:getIamPolicy`,
      { method: 'POST', body: {} },
    )) as { bindings: Array<{ role: string; members: string[] }>; etag: string };
  } catch (authErr) {
    console.warn(
      `[ensureShardSecurityPolicies] Initial getIamPolicy failed, trying platform SA auth:`,
      authErr,
    );
    const platformAuth = await getPlatformServiceAccountOAuthClient();
    activeAuth = platformAuth;
    policy = (await apiFetch(
      platformAuth,
      `https://cloudresourcemanager.googleapis.com/v3/projects/${targetProjectId}:getIamPolicy`,
      { method: 'POST', body: {} },
    )) as { bindings: Array<{ role: string; members: string[] }>; etag: string };
  }

  if (!policy) throw new Error(`Could not fetch IAM policy for project ${targetProjectId}`);

  const rolesToEnsure = [
    'roles/owner',
    'roles/editor',
    'roles/firebasehosting.admin',
    'roles/firebaserules.admin',
    'roles/datastore.owner',
    'roles/datastore.user',
    'roles/secretmanager.secretAccessor',
    'roles/logging.logWriter',
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
      `https://cloudresourcemanager.googleapis.com/v3/projects/${targetProjectId}:setIamPolicy`,
      { method: 'POST', body: { policy } },
    );
    console.info(
      `[ensureShardSecurityPolicies] Defensively granted IAM roles on ${targetProjectId}`,
    );
  }
}

export async function apiFetch(
  auth: OAuth2Client,
  url: string,
  options: { method?: string; body?: unknown; quotaProject?: string } = {},
): Promise<unknown> {
  const maxAttempts = 10;
  const startedAt = Date.now();
  const MAX_RETRY_MS = 60_000; // circuit breaker: máx 60s acumulados por sub-tarea
  let delayMs = 3000;
  let lastIamError = '';
  const canRetry = (i: number) => i < maxAttempts - 1 && Date.now() - startedAt < MAX_RETRY_MS;
  const sleepBackoff = (i: number, msg: string) => {
    const jitter = Math.floor(Math.random() * 1000);
    const currentDelay = Math.min(delayMs + jitter, 45000);
    console.warn(
      `[apiFetch] ${msg} Retrying attempt ${i + 1}/${maxAttempts} in ${currentDelay}ms...`,
    );
    return new Promise((r) => setTimeout(r, currentDelay)).then(() => {
      delayMs = Math.min(delayMs * 2, 45000);
    });
  };
  const iamError = (detail: string) => {
    const e = new Error(
      `IAM_PROPAGATION_FAILED: permiso insuficiente o en propagación sobre el proyecto destino. ` +
        `Revisar bindings del Orchestrator (secretmanager.admin, datastore.owner, firebase.admin, iam.serviceAccountUser). ${detail}`,
    ) as Error & { code?: string };
    e.code = 'IAM_PROPAGATION_FAILED';
    return e;
  };
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const tokenRes = await auth.getAccessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${tokenRes.token}`,
        'Content-Type': 'application/json',
      };
      if (options.quotaProject) {
        headers['x-goog-user-project'] = options.quotaProject;
      }
      const res = await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      if (res.status === 429 || res.status === 503) {
        if (!canRetry(i)) break;
        await sleepBackoff(i, `Rate limited / Service unavailable (${res.status}) on ${url}.`);
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        if (res.status === 429 || text.includes('RESOURCE_EXHAUSTED') || text.includes('429')) {
          if (!canRetry(i)) break;
          await sleepBackoff(i, `Quota/Rate limit exhausted on ${url}: ${text}.`);
          continue;
        }
        const isIamPropagation =
          res.status === 403 &&
          (text.includes('CONSUMER_INVALID') ||
            text.includes('Permission denied on resource project') ||
            text.includes('UNAUTHORIZED') ||
            text.toLowerCase().includes('secretmanager'));
        if (isIamPropagation) {
          lastIamError = text.slice(0, 300);
          if (!canRetry(i)) throw iamError(text.slice(0, 200));
          await sleepBackoff(i, `API propagation delay / IAM (403) on ${url}.`);
          continue;
        }
        if (
          text.includes('USER_PROJECT_DENIED') ||
          (res.status === 403 && text.includes('serviceusage'))
        ) {
          if (options.quotaProject) {
            console.warn(
              `[apiFetch] USER_PROJECT_DENIED with quotaProject ${options.quotaProject}. Retrying without quota project header...`,
            );
            delete options.quotaProject;
            continue;
          }
        }
        throw new Error(`${res.status} ${res.statusText}: ${text}`);
      }
      return res.json();
    } catch (err) {
      const errStr = String(err);
      if (
        canRetry(i) &&
        (errStr.includes('429') ||
          errStr.includes('RESOURCE_EXHAUSTED') ||
          errStr.includes('503') ||
          errStr.includes('CONSUMER_INVALID') ||
          errStr.includes('Permission denied on resource project'))
      ) {
        await sleepBackoff(i, `Transient/Propagation error on ${url}: ${errStr}.`);
        continue;
      }
      throw err;
    }
  }
  if (lastIamError) {
    throw iamError(lastIamError);
  }
  throw new Error(`Max retry attempts reached for apiFetch: ${url}`);
}

export async function retry<T>(
  fn: () => Promise<T>,
  attempts: number,
  delayMs: number,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, delayMs * i));
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function pickBillingAccount(db: Firestore): Promise<string> {
  // New schema: billing_accounts with status == 'ACTIVE'. Legacy fallback: billingAccounts with active == true.
  let accountsSnap = await db.collection('billing_accounts').where('status', '==', 'ACTIVE').get();
  if (accountsSnap.empty) {
    accountsSnap = await db.collection('billingAccounts').where('active', '==', true).get();
  }
  if (accountsSnap.empty) {
    accountsSnap = await db.collection('billing_accounts').get();
  }
  if (accountsSnap.empty) {
    accountsSnap = await db.collection('billingAccounts').get();
  }
  if (accountsSnap.empty) throw new Error('No active billing accounts configured.');

  const storesSnap = await db
    .collection('stores')
    .where('status', 'in', ['provisioning', 'active', 'suspended'])
    .get();

  const usageMap: Record<string, number> = {};
  storesSnap.docs.forEach((d) => {
    const bid = d.data()['billingAccountId'] as string | undefined;
    if (bid) usageMap[bid] = (usageMap[bid] ?? 0) + 1;
  });

  let bestId: string | null = null;
  let bestRemaining = -Infinity;

  accountsSnap.docs.forEach((d) => {
    const data = d.data();
    // Prefer the stored currentProjects counter; fall back to computed usage from live stores.
    const maxProjects = (data['maxProjects'] as number | undefined) ?? Infinity;
    const currentProjects = data['currentProjects'] as number | undefined;
    const used = currentProjects !== undefined ? currentProjects : (usageMap[d.id] ?? 0);
    const remaining = maxProjects - used;
    if (remaining > bestRemaining) {
      bestRemaining = remaining;
      bestId = d.id;
    }
  });

  if (!bestId || bestRemaining <= 0) {
    throw new Error(
      'All billing accounts are at capacity. Add a new billing account from Settings → Facturación.',
    );
  }

  return bestId;
}

export async function pollOperation(
  auth: OAuth2Client,
  operationName: string,
  apiBase: string,
  maxAttempts = 36,
  delayMs = 5000,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const op = (await apiFetch(auth, `${apiBase}/${operationName}`)) as {
      done?: boolean;
      error?: { message: string };
    };
    if (op.done) {
      if (op.error) throw new Error(op.error.message);
      return;
    }
  }
  throw new Error(`Operation ${operationName} timed out after ${maxAttempts * delayMs}ms`);
}

export async function sendDirectEmail(
  to: string,
  subject: string,
  html: string,
  text: string,
): Promise<void> {
  const secretsClient = new SecretManagerServiceClient();
  let smtpPassword = '';
  try {
    const [pwVersion] = await secretsClient.accessSecretVersion({
      name: `projects/${PLATFORM_PROJECT}/secrets/ext-firestore-send-email-SMTP_PASSWORD/versions/latest`,
    });
    smtpPassword = pwVersion.payload!.data!.toString().trim();
  } catch {
    try {
      const [pwVersion] = await secretsClient.accessSecretVersion({
        name: `projects/${PLATFORM_PROJECT}/secrets/SMTP_PASSWORD/versions/latest`,
      });
      smtpPassword = pwVersion.payload!.data!.toString().trim();
    } catch {
      smtpPassword = process.env.SMTP_PASS || '';
    }
  }

  if (!smtpPassword) {
    console.warn('[sendDirectEmail] No se encontró contraseña SMTP en Secret Manager.');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: 'vertex.tech.dev@gmail.com',
      pass: smtpPassword,
    },
  });

  const cleanTo = to.replace(/[^a-zA-Z0-9@._-]/g, '');
  const domainPart = 'vertex.tech';
  const messageId = `<store-welcome-${Date.now()}-${Math.random().toString(36).slice(2, 9)}@${domainPart}>`;
  const entityRefId = `vertex-sub-${cleanTo}`;

  await transporter.sendMail({
    from: '"Vertex Platform" <notificaciones@vertex.tech>',
    replyTo: 'notificaciones@vertex.tech',
    to,
    subject,
    text,
    html,
    headers: {
      'X-Priority': '1',
      'X-MSMail-Priority': 'High',
      Importance: 'High',
      'List-Unsubscribe': `<mailto:bajas@vertex.tech?subject=Unsubscribe%20${encodeURIComponent(cleanTo)}>`,
      'Message-ID': messageId,
      'X-Entity-Ref-ID': entityRefId,
    },
  });
}

export interface OwnerWelcomeEmailData {
  ownerEmail: string;
  storeName: string;
  slug: string;
  publicUrl: string;
  adminUrl: string;
  trialDays?: number | null;
}

export async function notifyOwnerStoreWelcome(data: OwnerWelcomeEmailData): Promise<void> {
  const subject = `¡Bienvenido a Vertex! Tu tienda "${data.storeName}" ya está lista`;

  const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 24px; }
    .card { background: #1e293b; border-radius: 12px; border: 1px solid #334155; max-width: 600px; margin: 0 auto; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
    .logo { color: #6366f1; font-size: 24px; font-weight: bold; margin-bottom: 24px; display: inline-block; }
    h1 { font-size: 20px; color: #ffffff; margin-top: 0; }
    p { line-height: 1.6; color: #cbd5e1; font-size: 15px; }
    .actions { margin: 28px 0; display: flex; gap: 12px; flex-wrap: wrap; }
    .btn { display: inline-block; background: #6366f1; color: #ffffff !important; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; }
    .btn-secondary { background: #334155; color: #cbd5e1 !important; border: 1px solid #475569; }
    .details { background: #0f172a; border-radius: 8px; padding: 16px; margin: 20px 0; border: 1px solid #334155; }
    .footer { font-size: 12px; color: #64748b; margin-top: 32px; border-top: 1px solid #334155; padding-top: 16px; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">VERTEX COMMERCE</div>
    <h1>¡Felicitaciones! Tu tienda online está lista para vender</h1>
    <p>Hola,</p>
    <p>Nos complace darte la bienvenida a <strong>Vertex Commerce</strong>. Tu tienda <strong>${data.storeName}</strong> ha sido aprovisionada y configurada exitosamente en nuestra nube de alto rendimiento.</p>
    
    <div class="details">
      <p style="margin: 4px 0;"><strong>🌐 Tienda pública:</strong> <a href="${data.publicUrl}" style="color: #818cf8;">${data.publicUrl}</a></p>
      <p style="margin: 4px 0;"><strong>⚙️ Panel de administración:</strong> <a href="${data.adminUrl}" style="color: #818cf8;">${data.adminUrl}</a></p>
      ${data.trialDays ? `<p style="margin: 4px 0;"><strong>✨ Período de prueba bonificado:</strong> ${data.trialDays} días</p>` : ''}
    </div>

    <div class="actions">
      <a href="${data.publicUrl}" class="btn" target="_blank" rel="noopener">Ver mi Tienda</a>
      <a href="${data.adminUrl}" class="btn btn-secondary" target="_blank" rel="noopener">Administrar Catálogo</a>
    </div>

    <p>Podés comenzar a cargar tus productos, personalizar tu diseño y vincular tu cuenta de Mercado Pago desde el panel de control de tu tienda.</p>

    <div class="footer">
      Vertex Commerce Platform • Infraestructura SaaS Multi-Tenant<br>
      Si tenés alguna consulta, respondé a este correo o escribinos a notificaciones@vertex.tech.
    </div>
  </div>
</body>
</html>
`;

  const text = `
¡Bienvenido a Vertex Commerce!

Tu tienda "${data.storeName}" ya está lista y configurada para vender.

- Tienda pública: ${data.publicUrl}
- Panel de administración: ${data.adminUrl}
${data.trialDays ? `- Período de prueba gratuito: ${data.trialDays} días` : ''}

Podés ingresar al panel de administración para configurar tus productos, métodos de pago y diseño.

Atentamente,
El equipo de Vertex Commerce
notificaciones@vertex.tech
`;

  await sendDirectEmail(data.ownerEmail, subject, html, text);
}

export interface NewStoreNotificationData {
  storeId: string;
  storeName: string;
  slug: string;
  ownerEmail: string;
  verticalId?: string;
  projectId?: string;
  shardMode?: string;
  siteUrl?: string;
  tier?: string;
  billingCycle?: string;
  subscriptionStatus?: string;
  trialDays?: number | null;
  createdAt?: Date;
}

export async function notifyAdminNewStoreCreated(data: NewStoreNotificationData): Promise<void> {
  const adminEmail = process.env.PLATFORM_ADMIN_EMAIL || 'vertex.tech.dev@gmail.com';
  const subject = `🚀 Nueva Tienda Creada: ${data.storeName} (${data.slug})`;
  const storeUrl = data.siteUrl || `https://vtx-${data.slug}.web.app`;
  const platformAdminUrl = 'https://vertex-platform.web.app/stores';

  let planDisplay = `${data.tier || 'PRO'} (${data.billingCycle === 'annual' ? 'Facturación Anual' : 'Facturación Mensual'})`;
  if (data.subscriptionStatus === 'complimentary') {
    planDisplay = `🎁 PRO — Bonificado / Gratuito (100% Cortesía)`;
  } else if (data.subscriptionStatus === 'trial') {
    planDisplay = `⏳ Período de Prueba (${data.trialDays || 14} días)`;
  }

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f172a; color: #f8fafc; margin: 0; padding: 20px; }
    .card { max-width: 600px; margin: 0 auto; background: #1e293b; border-radius: 12px; border: 1px solid #334155; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
    .header { background: linear-gradient(135deg, #6366f1 0%, #4338ca 100%); padding: 24px; text-align: center; }
    .header h1 { margin: 0; color: #ffffff; font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
    .content { padding: 24px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; text-transform: uppercase; background: #22c55e; color: #000000; }
    .table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    .table td { padding: 10px 12px; border-bottom: 1px solid #334155; font-size: 14px; }
    .table td.label { color: #94a3b8; font-weight: 500; width: 40%; }
    .table td.value { color: #f1f5f9; font-weight: 600; }
    .btn-container { text-align: center; margin-top: 24px; }
    .btn { display: inline-block; padding: 12px 24px; background: #6366f1; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 0 6px; font-size: 14px; }
    .btn-secondary { background: #334155; color: #f8fafc; border: 1px solid #475569; }
    .footer { padding: 16px 24px; background: #0f172a; text-align: center; font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>🚀 ¡Nueva Tienda Creada en Producción!</h1>
    </div>
    <div class="content">
      <p style="margin-top: 0; font-size: 15px; color: #cbd5e1; line-height: 1.5;">Se ha completado el aprovisionamiento y despliegue de una nueva tienda en la plataforma Vertex Commerce.</p>
      
      <table class="table">
        <tr>
          <td class="label">Nombre de la Tienda</td>
          <td class="value">${data.storeName}</td>
        </tr>
        <tr>
          <td class="label">Slug / Subdominio</td>
          <td class="value"><code style="color: #38bdf8;">${data.slug}</code></td>
        </tr>
        <tr>
          <td class="label">Email del Propietario</td>
          <td class="value">${data.ownerEmail}</td>
        </tr>
        <tr>
          <td class="label">Rubro Comercial</td>
          <td class="value">${data.verticalId || 'General'}</td>
        </tr>
        <tr>
          <td class="label">Proyecto Firebase / Shard</td>
          <td class="value"><code style="color: #a78bfa;">${data.projectId || 'shared-shard'}</code></td>
        </tr>
        <tr>
          <td class="label">Modo de Aprovisionamiento</td>
          <td class="value">${data.shardMode === 'dedicated' ? '💎 Shard Dedicado' : '⚡ Shard Compartido'}</td>
        </tr>
        <tr>
          <td class="label">Plan / Modalidad</td>
          <td class="value">${planDisplay}</td>
        </tr>
        <tr>
          <td class="label">Fecha de Creación</td>
          <td class="value">${(data.createdAt || new Date()).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}</td>
        </tr>
      </table>

      <div class="btn-container">
        <a href="${storeUrl}" class="btn" target="_blank">🌐 Visitar Tienda</a>
        <a href="${platformAdminUrl}" class="btn btn-secondary" target="_blank">⚙️ Abrir Panel Vertex</a>
      </div>
    </div>
    <div class="footer">
      Vertex Commerce Platform • Notificación Automática de Infraestructura
    </div>
  </div>
</body>
</html>
`;

  const text = `
Nueva Tienda Creada en Vertex:
- Tienda: ${data.storeName} (${data.slug})
- Propietario: ${data.ownerEmail}
- Rubro: ${data.verticalId || 'General'}
- Proyecto: ${data.projectId || 'shared-shard'}
- URL: ${storeUrl}
- Plan: ${data.tier || 'PRO'} (${data.billingCycle || 'monthly'})
- Fecha: ${(data.createdAt || new Date()).toISOString()}
`;

  try {
    await sendDirectEmail(adminEmail, subject, html, text);
    console.info(
      `[notifyAdminNewStoreCreated] Email de notificación enviado a ${adminEmail} para la tienda ${data.slug}`,
    );
  } catch (err) {
    console.error(
      `[notifyAdminNewStoreCreated] Error al enviar notificación a ${adminEmail}:`,
      err,
    );
  }
}
