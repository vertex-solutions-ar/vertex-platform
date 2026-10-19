import { GoogleAuth } from 'google-auth-library';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((a) => a.startsWith(prefix));
  if (arg) return arg.slice(prefix.length);
  const idx = process.argv.slice(2).indexOf(`--${name}`);
  if (idx !== -1 && process.argv.slice(2)[idx + 1]) {
    return process.argv.slice(2)[idx + 1];
  }
  return undefined;
}

const inputSlug = readArg('slug') || 'vtx-c-b-market';
const platformEnv = readArg('env') || 'prod';
const platformProjectId =
  platformEnv === 'prod' ? 'vertex-platform-app' : 'vertex-platform-dev';
const masterStorefrontProjectId =
  platformEnv === 'prod' ? 'ecommerce-vertex' : 'ecommerce-vertex-dev';

async function main() {
  console.log(`[Remediate Auth] Starting for target: "${inputSlug}" on platform "${platformProjectId}"...`);

  // Initialize Platform Firestore
  const platformApp = getApps().find((a) => a.name === 'platform') ||
    initializeApp({ projectId: platformProjectId }, 'platform');
  const platformDb = getFirestore(platformApp);

  // Paso A (Identificación)
  console.log(`[Paso A] Resolving store in platform Firestore...`);
  let storeDoc: FirebaseFirestore.DocumentSnapshot | null = null;

  // Search by docId
  const directDoc = await platformDb.collection('stores').doc(inputSlug).get();
  if (directDoc.exists) {
    storeDoc = directDoc;
  } else {
    // Search by slug
    const bySlug = await platformDb
      .collection('stores')
      .where('slug', '==', inputSlug)
      .limit(1)
      .get();
    if (!bySlug.empty) {
      storeDoc = bySlug.docs[0];
    } else {
      // Also try stripped prefix or siteId
      const cleanSlug = inputSlug.startsWith('vtx-') ? inputSlug.substring(4) : inputSlug;
      const byCleanSlug = await platformDb
        .collection('stores')
        .where('slug', '==', cleanSlug)
        .limit(1)
        .get();
      if (!byCleanSlug.empty) {
        storeDoc = byCleanSlug.docs[0];
      } else {
        const bySiteId = await platformDb
          .collection('stores')
          .where('siteId', '==', inputSlug)
          .limit(1)
          .get();
        if (!bySiteId.empty) {
          storeDoc = bySiteId.docs[0];
        }
      }
    }
  }

  if (!storeDoc || !storeDoc.exists) {
    throw new Error(`Store not found for slug/id "${inputSlug}" in ${platformProjectId}`);
  }

  const storeData = storeDoc.data()!;
  const storeId = storeDoc.id;
  const storeSlug = storeData['slug'] || inputSlug;
  const shardId = storeData['shardId'];
  const runtimeProjectId =
    storeData['runtimeProjectId'] || storeData['firebaseProjectId'];
  const siteId = storeData['runtimeSiteId'] || storeData['siteId'] || inputSlug;
  const ownerEmail = storeData['ownerEmail'] || 'leivalihue@gmail.com';
  const customDomain = storeData['customDomain'] || null;

  console.log(`[Paso A] Store identified:`, {
    storeId,
    storeSlug,
    shardId,
    runtimeProjectId,
    siteId,
    ownerEmail,
    customDomain,
  });

  if (!runtimeProjectId) {
    throw new Error(`Store does not have runtimeProjectId configured.`);
  }

  // GoogleAuth Client for GCP Identity Toolkit REST APIs
  const googleAuth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const authClient = await googleAuth.getClient();

  // Retrieve Master Google IdP Client ID & Secret
  console.log(`[Paso B] Reading master Google OAuth credentials from ${masterStorefrontProjectId}...`);
  let masterClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  let masterClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!masterClientId || !masterClientSecret) {
    try {
      const masterRes = (await authClient.request({
        url: `https://identitytoolkit.googleapis.com/v2/projects/${masterStorefrontProjectId}/defaultSupportedIdpConfigs/google.com`,
      })) as { data: { clientId?: string; clientSecret?: string } };
      masterClientId = masterRes.data.clientId;
      masterClientSecret = masterRes.data.clientSecret;
      console.log(`[Paso B] Master Google IdP credentials fetched successfully.`);
    } catch (err: any) {
      console.warn(`[Paso B] Could not fetch master IdP config from ${masterStorefrontProjectId}:`, err.message);
    }
  }

  if (!masterClientId || !masterClientSecret) {
    throw new Error('Missing Google OAuth Client ID and Secret for Identity Toolkit.');
  }

  // Paso B (Habilitación de Google IdP vía API en targetProjectId)
  console.log(`[Paso B] Enabling Google IdP on target project: "${runtimeProjectId}"...`);
  const targetIdpUrl = `https://identitytoolkit.googleapis.com/v2/projects/${runtimeProjectId}/defaultSupportedIdpConfigs/google.com`;
  try {
    await authClient.request({
      url: targetIdpUrl,
      method: 'PATCH',
      params: { updateMask: 'enabled,clientId,clientSecret' },
      data: {
        enabled: true,
        clientId: masterClientId,
        clientSecret: masterClientSecret,
      },
    });
    console.log(`[Paso B] Google IdP patched successfully on ${runtimeProjectId}.`);
  } catch (patchErr: any) {
    console.log(`[Paso B] PATCH failed (${patchErr.status || patchErr.message}), attempting POST...`);
    await authClient.request({
      url: `https://identitytoolkit.googleapis.com/v2/projects/${runtimeProjectId}/defaultSupportedIdpConfigs?idpId=google.com`,
      method: 'POST',
      data: {
        name: `projects/${runtimeProjectId}/defaultSupportedIdpConfigs/google.com`,
        enabled: true,
        clientId: masterClientId,
        clientSecret: masterClientSecret,
      },
    });
    console.log(`[Paso B] Google IdP created successfully on ${runtimeProjectId}.`);
  }

  // Paso C (Dominios Autorizados)
  console.log(`[Paso C] Updating authorized domains on ${runtimeProjectId}...`);
  const configUrl = `https://identitytoolkit.googleapis.com/v2/projects/${runtimeProjectId}/config`;
  const currentConfigRes = (await authClient.request({ url: configUrl })) as {
    data: { authorizedDomains?: string[] };
  };
  const currentDomains = currentConfigRes.data.authorizedDomains || [];

  const requiredDomains = [
    'localhost',
    '127.0.0.1',
    `${runtimeProjectId}.firebaseapp.com`,
    `${runtimeProjectId}.web.app`,
    'ecommerce-vertex.firebaseapp.com',
    'ecommerce-vertex.web.app',
    'vertex-platform-app.firebaseapp.com',
    'vertex-platform-app.web.app',
    `${siteId}.web.app`,
    `${siteId}.firebaseapp.com`,
  ];
  if (customDomain) {
    requiredDomains.push(customDomain.replace(/^https?:\/\//, '').split('/')[0]);
  }

  const mergedDomains = Array.from(new Set([...currentDomains, ...requiredDomains]));
  await authClient.request({
    url: `${configUrl}?updateMask=authorizedDomains`,
    method: 'PATCH',
    data: {
      authorizedDomains: mergedDomains,
    },
  });
  console.log(`[Paso C] Authorized domains updated successfully:`, mergedDomains);

  // Paso D (Preautorización de Roles y Claims en Shard y Master)
  console.log(`[Paso D] Preauthorizing admin roles and injecting claims for ${ownerEmail}...`);
  const normalizedEmail = ownerEmail.trim().toLowerCase();

  // 1. Shard Firestore app
  const shardApp = getApps().find((a) => a.name === runtimeProjectId) ||
    initializeApp({ projectId: runtimeProjectId }, runtimeProjectId);
  const shardDb = getFirestore(shardApp);
  const shardAuth = getAuth(shardApp);

  const rolePayload = {
    email: normalizedEmail,
    role: 'owner',
    storeId: storeSlug,
    tenantId: storeSlug,
    status: 'active',
    updatedAt: FieldValue.serverTimestamp(),
  };

  // Write admin_roles in Shard DB for both storeSlug and siteId
  const roleDocId1 = `${storeSlug}_${normalizedEmail}`;
  const roleDocId2 = `${siteId}_${normalizedEmail}`;
  await shardDb.collection('admin_roles').doc(roleDocId1).set(rolePayload, { merge: true });
  await shardDb.collection('admin_roles').doc(roleDocId2).set(rolePayload, { merge: true });
  console.log(`[Paso D] Wrote admin_roles on shard ${runtimeProjectId} (${roleDocId1}, ${roleDocId2})`);

  // Write admin_roles in Platform DB
  await platformDb.collection('admin_roles').doc(roleDocId1).set(rolePayload, { merge: true });
  await platformDb.collection('admin_roles').doc(roleDocId2).set(rolePayload, { merge: true });
  console.log(`[Paso D] Wrote admin_roles on platform ${platformProjectId} (${roleDocId1}, ${roleDocId2})`);

  // Also check Master DB (ecommerce-vertex)
  try {
    const masterApp = getApps().find((a) => a.name === masterStorefrontProjectId) ||
      initializeApp({ projectId: masterStorefrontProjectId }, masterStorefrontProjectId);
    const masterDb = getFirestore(masterApp);
    await masterDb.collection('admin_roles').doc(roleDocId1).set(rolePayload, { merge: true });
    await masterDb.collection('admin_roles').doc(roleDocId2).set(rolePayload, { merge: true });
    console.log(`[Paso D] Wrote admin_roles on master ${masterStorefrontProjectId} (${roleDocId1}, ${roleDocId2})`);
  } catch (masterErr: any) {
    console.warn(`[Paso D] Note on master admin_roles:`, masterErr.message);
  }

  // Inject Custom Claims in Shard Auth if user exists
  try {
    const shardUser = await shardAuth.getUserByEmail(normalizedEmail);
    await shardAuth.setCustomUserClaims(shardUser.uid, {
      role: 'owner',
      tenantId: storeSlug,
      storeId: storeSlug,
      admin: true,
    });
    console.log(`[Paso D] Injected custom claims in Shard Auth (${runtimeProjectId}) for user ${shardUser.uid}`);
  } catch (err: any) {
    if (err.code === 'auth/user-not-found') {
      console.log(`[Paso D] User ${normalizedEmail} does not exist yet in Shard Auth. Claims will be auto-assigned upon first Google login via preauthorized admin_roles document.`);
    } else {
      console.warn(`[Paso D] Error querying Shard Auth:`, err.message);
    }
  }

  // Inject Custom Claims in Master Storefront Auth if user exists
  try {
    const masterAuth = getAuth(getApps().find((a) => a.name === masterStorefrontProjectId)!);
    const masterUser = await masterAuth.getUserByEmail(normalizedEmail);
    await masterAuth.setCustomUserClaims(masterUser.uid, {
      role: 'owner',
      tenantId: storeSlug,
      storeId: storeSlug,
      admin: true,
    });
    console.log(`[Paso D] Injected custom claims in Master Storefront Auth (${masterStorefrontProjectId}) for user ${masterUser.uid}`);
  } catch (err: any) {
    if (err.code === 'auth/user-not-found') {
      console.log(`[Paso D] User ${normalizedEmail} does not exist yet in Master Storefront Auth.`);
    } else {
      console.warn(`[Paso D] Error querying Master Storefront Auth:`, err.message);
    }
  }

  console.log(`\n🎉 [Remediate Auth] Successfully remediated authentication for store "${inputSlug}"!`);
}

main().catch((err) => {
  console.error('[Remediate Auth] Fatal error:', err);
  process.exit(1);
});
