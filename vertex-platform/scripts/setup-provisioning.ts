/**
 * One-time setup: stores Application Default Credentials and GitHub Service/Bot Token
 * in Google Cloud Secret Manager so the provisionStore Cloud Function can use them.
 *
 * Zero-Personal Actor Policy:
 *   Use a dedicated Service Account / GitHub App installation token (e.g. vertex-deployer-bot[bot])
 *   or fine-grained org PAT to avoid personal human developer attribution.
 *
 * Prerequisites:
 *   1. gcloud auth application-default login  (already done)
 *   2. A GitHub Token (Bot / Org Service Token) with scopes: repo + workflow
 *
 * Usage:
 *   npm run setup-provisioning
 *   npm run setup-provisioning -- --github-pat=ghp_xxxxxxxxxxxx
 *   npm run setup-provisioning -- --owner-pool-file=/abs/path/owners.json
 */
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const args = process.argv.slice(2);
const isDev = args.includes('--dev');
const PROJECT_ID = isDev ? 'vertex-platform-dev' : 'vertex-platform-app';

const patArg = args.find((a) => a.startsWith('--github-pat='));
const githubPat = patArg?.split('=')[1];
const ownerPoolArg = args.find((a) => a.startsWith('--owner-pool-file='));
const ownerPoolFile = ownerPoolArg?.split('=')[1];

interface OwnerCredentialsSecret {
  id?: string;
  label?: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  maxProjects?: number;
}

void (async () => {
  console.log(`🔑 Initializing Secret Manager setup for project: "${PROJECT_ID}"...`);
  const client = new SecretManagerServiceClient();

  // ── Store ADC credentials ────────────────────────────────────────────────
  const adcPath = join(homedir(), '.config', 'gcloud', 'application_default_credentials.json');
  let adcJson: string;
  try {
    adcJson = readFileSync(adcPath, 'utf-8');
    const parsed = JSON.parse(adcJson) as { type: string };
    if (parsed.type !== 'authorized_user') {
      console.error(`❌ ADC credentials are type "${parsed.type}", need "authorized_user".`);
      console.error('   Run: gcloud auth application-default login');
      process.exit(1);
    }
  } catch {
    console.error('❌ Could not read ADC credentials.');
    console.error('   Run: gcloud auth application-default login');
    process.exit(1);
  }

  await upsertSecret(client, 'platform-owner-credentials', adcJson);
  console.log('✅ ADC credentials stored in Secret Manager.');

  let ownerPool: OwnerCredentialsSecret[];
  if (ownerPoolFile) {
    ownerPool = loadOwnerPool(ownerPoolFile);
    console.log(
      `✅ Loaded ${ownerPool.length} provisioning owner credential(s) from ${ownerPoolFile}.`,
    );
  } else {
    const parsed = JSON.parse(adcJson) as OwnerCredentialsSecret;
    ownerPool = [{ id: 'primary', label: 'Primary owner', ...parsed }];
    console.log('ℹ️ No owner pool file provided. Creating a single-owner pool from local ADC.');
  }

  await upsertSecret(client, 'platform-owner-credentials-pool', JSON.stringify(ownerPool, null, 2));
  console.log('✅ Provisioning owner pool stored in Secret Manager.');

  // ── Store GitHub PAT ─────────────────────────────────────────────────────
  if (githubPat) {
    await upsertSecret(client, 'github-pat', githubPat);
    console.log('✅ GitHub PAT stored in Secret Manager.');
  } else {
    console.log('\n⚠️  GitHub PAT not provided. Provisioning will fail at the deploy step.');
    console.log(
      '   Create a PAT at https://github.com/settings/tokens with scopes: repo, workflow',
    );
    console.log('   Then run: npm run setup-provisioning -- --github-pat=ghp_xxxx');
  }

  console.log('\n✅ Setup complete. You can now create stores from the platform.');
})();

async function upsertSecret(
  client: SecretManagerServiceClient,
  secretId: string,
  payload: string,
): Promise<void> {
  const secretName = `projects/${PROJECT_ID}/secrets/${secretId}`;

  // Create secret if it doesn't exist
  try {
    await client.createSecret({
      parent: `projects/${PROJECT_ID}`,
      secretId,
      secret: { replication: { automatic: {} } },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already exists') && !msg.includes('409')) throw err;
  }

  // Add a new version
  await client.addSecretVersion({
    parent: secretName,
    payload: { data: Buffer.from(payload, 'utf-8') },
  });
}

function loadOwnerPool(filePath: string): OwnerCredentialsSecret[] {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as
      | OwnerCredentialsSecret[]
      | { owners?: OwnerCredentialsSecret[] };
    const owners = Array.isArray(raw) ? raw : raw.owners;
    if (!Array.isArray(owners) || owners.length === 0) {
      throw new Error('Owner pool file must contain a non-empty array.');
    }
    for (const owner of owners) {
      if (!owner.client_id || !owner.client_secret || !owner.refresh_token) {
        throw new Error(
          'Each owner credential requires client_id, client_secret and refresh_token.',
        );
      }
    }
    return owners;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Could not read owner pool file: ${msg}`);
    process.exit(1);
  }
}
