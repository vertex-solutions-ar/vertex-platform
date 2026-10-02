import * as crypto from 'crypto';

/**
 * Validación de tokens OIDC de GitHub Actions (id-token) para automatizar el
 * despliegue del storefront SIN depender de secrets manuales compartidos.
 *
 * El workflow de ecommerce-vertex solicita un id_token (audience 'vertex-platform')
 * y completeStoreDeployment lo valida contra las JWKS de GitHub:
 *  - issuer: https://token.actions.githubusercontent.com
 *  - audience: 'vertex-platform'
 *  - repository: Vertex-Tech-Devs/ecommerce-vertex (configurable)
 *  - ref: rama esperada (develop/main)
 *  - firma RS256 + expiración
 */
const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_JWKS_URL = 'https://token.actions.githubusercontent.com/.well-known/jwks';
const OIDC_AUDIENCE = 'vertex-platform';

let cachedJwks: { keys: Array<{ kid: string; n: string; e: string }>; fetchedAt: number } | null =
  null;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h — GitHub rota keys, no cachear para siempre

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function fetchJwks(): Promise<Array<{ kid: string; n: string; e: string }>> {
  const now = Date.now();
  if (cachedJwks && now - cachedJwks.fetchedAt < JWKS_TTL_MS) {
    return cachedJwks.keys;
  }
  const res = await fetch(GITHUB_JWKS_URL, { signal: AbortSignal.timeout(10000) });
  const data = (await res.json()) as {
    keys?: Array<{ kid?: string; n?: string; e?: string }>;
  };
  const keys = (data.keys ?? [])
    .filter((k) => k.kid && k.n && k.e)
    .map((k) => ({ kid: k.kid!, n: k.n!, e: k.e! }));
  cachedJwks = { keys, fetchedAt: now };
  return keys;
}

/**
 * Valida un id_token OIDC de GitHub Actions.
 * Devuelve true solo si la firma, issuer, audience, repository, ref y expiración son correctos.
 */
export async function verifyGitHubOidcToken(
  idToken: string,
  expected: { repository: string; ref?: string },
): Promise<boolean> {
  try {
    const [headerB64, payloadB64, signatureB64] = idToken.split('.');
    if (!headerB64 || !payloadB64 || !signatureB64) return false;

    const header = JSON.parse(base64UrlDecode(headerB64).toString('utf8')) as {
      alg?: string;
      kid?: string;
    };
    if (header.alg !== 'RS256' || !header.kid) return false;

    const payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as {
      iss?: string;
      aud?: string;
      repository?: string;
      ref?: string;
      exp?: number;
    };
    if (payload.iss !== GITHUB_OIDC_ISSUER) return false;
    if (payload.aud !== OIDC_AUDIENCE) return false;
    if (expected.repository) {
      const allowedRepositories = [
        expected.repository.toLowerCase(),
        'vertex-solutions-ar/ecommerce-vertex',
        'vertex-tech-devs/ecommerce-vertex',
      ];
      const tokenRepo = payload.repository?.toLowerCase() || '';
      if (!allowedRepositories.includes(tokenRepo)) {
        return false;
      }
    }
    if (expected.ref) {
      // El workflow puede enviar 'main' mientras el claim del token es 'refs/heads/main'.
      const expectedRef = expected.ref.startsWith('refs/')
        ? expected.ref
        : `refs/heads/${expected.ref}`;
      if (payload.ref !== expectedRef) return false;
    }
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
      return false;
    }

    const jwks = await fetchJwks();
    const key = jwks.find((k) => k.kid === header.kid);
    if (!key) return false;

    const publicKey = crypto.createPublicKey({
      key: { kty: 'RSA', n: key.n, e: key.e },
      format: 'jwk',
    });
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${payloadB64}`);
    return verifier.verify(publicKey, base64UrlDecode(signatureB64));
  } catch {
    return false;
  }
}
