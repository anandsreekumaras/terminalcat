// Cloudflare Access JWT verification.
//
// Every HTTP request and every WS upgrade must carry:
//   Cf-Access-Jwt-Assertion : signed JWT minted by Cloudflare Access
//   Cf-Connecting-Ip        : presence-only heuristic that the request came
//                             through Cloudflare (see caveat below)
//
// What this module DOES verify:
//   - JWT signature against Cloudflare's JWKS (cached 1h)
//   - issuer is https://<TEAM_DOMAIN>.cloudflareaccess.com
//   - audience matches CF_ACCESS_AUD
//   - exp / iat / nbf (jose handles these by default in jwtVerify)
//
// What this module does NOT cover:
//   - The Cf-Connecting-Ip presence check is in server.ts, not here. That
//     header is unsigned — anyone bypassing Cloudflare can forge it. Its
//     value here is purely as a "did the request route through Cloudflare?"
//     heuristic on top of the real defense (JWT sig + 127.0.0.1 bind).
//     Documented in the AUTH section of the project spec.
//   - We do NOT trust Cf-Access-Authenticated-User-Email — it's unsigned.
//     Always read identity from the verified JWT's `email` claim.

import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import { config } from './config';

const issuer = `https://${config.CF_ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`;
const jwksUrl = new URL(`${issuer}/cdn-cgi/access/certs`);

// jose's JWKS handle:
//   cacheMaxAge      — how long a successful fetch is reused (1h per spec).
//   cooldownDuration — minimum interval between re-fetches when an unknown
//                      kid arrives. 5 minutes guards against a key-rotation
//                      storm hammering CF's certs endpoint.
//   timeoutDuration  — HTTP timeout for the JWKS fetch itself.
const JWKS = createRemoteJWKSet(jwksUrl, {
  cacheMaxAge: 60 * 60 * 1000,
  cooldownDuration: 5 * 60 * 1000,
  timeoutDuration: 5_000,
});

// Verification result cache. Same token, ~4-6 static-asset hits per pageload
// — we re-verify the same JWT each time. TTL well under typical JWT lifetime
// (~6h) so we never serve a stale "ok" past the actual exp by more than the
// TTL window. Failures are NOT cached: a recoverable failure (kid not yet
// in JWKS, transient network) should retry.
const VERIFY_CACHE_TTL_MS = 30_000;
const VERIFY_CACHE_MAX = 1024;
const verifyCache = new Map<string, { result: AuthOk; cachedAt: number }>();

// JWKS prefetch (network-warm): a fire-and-forget fetch at module load so
// the TLS session, DNS, and TCP for cloudflareaccess.com are warm before
// the very first user request arrives. jose's own JWKS cache repopulates
// on first verify, but its fetch then reuses the warmed connection.
// Saves the cold first-request ~150–250ms.
fetch(jwksUrl.toString()).then((r) => r.arrayBuffer()).catch(() => {
  // Best effort. If CF is briefly unreachable here, jose retries on the
  // first real verifyAccessJwt call. We don't want a failing prefetch to
  // crash startup or even surface in logs at info level.
});

export type AuthOk = { ok: true; email: string; sub: string };
export type AuthFail = { ok: false; reason: string };
export type AuthResult = AuthOk | AuthFail;

export async function verifyAccessJwt(token: string): Promise<AuthResult> {
  const now = Date.now();
  const cached = verifyCache.get(token);
  if (cached) {
    if (now - cached.cachedAt < VERIFY_CACHE_TTL_MS) return cached.result;
    verifyCache.delete(token);
  }

  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    ({ payload } = await jwtVerify(token, JWKS, {
      audience: config.CF_ACCESS_AUD,
      issuer,
    }));
  } catch (err) {
    return { ok: false, reason: classifyJoseError(err) };
  }

  // CF Access JWTs always carry `email` and `sub` for human SSO logins.
  // Service-token JWTs (M2M) have a different shape — they omit `email`.
  // We only need human auth for v1; reject service tokens explicitly.
  const email = payload.email;
  const sub = payload.sub;
  if (typeof email !== 'string' || !email) {
    return { ok: false, reason: 'JWT missing email claim (service token?)' };
  }
  if (typeof sub !== 'string' || !sub) {
    return { ok: false, reason: 'JWT missing sub claim' };
  }
  if (verifyCache.size >= VERIFY_CACHE_MAX) {
    // Map iteration order is insertion order — evict the oldest entry.
    const oldest = verifyCache.keys().next().value;
    if (oldest !== undefined) verifyCache.delete(oldest);
  }
  const result: AuthOk = { ok: true, email, sub };
  verifyCache.set(token, { result, cachedAt: now });
  return result;
}

// Map jose's typed errors to short diagnostic strings. We log these but
// never return them to the client — the body is just "unauthorized".
function classifyJoseError(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return 'JWT expired';
  if (err instanceof joseErrors.JWTClaimValidationFailed) return `JWT claim invalid: ${err.message}`;
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return 'JWT signature invalid';
  if (err instanceof joseErrors.JWKSNoMatchingKey) return 'JWT kid not in JWKS';
  if (err instanceof joseErrors.JOSEError) return `jose error: ${err.code}: ${err.message}`;
  if (err instanceof Error) return `unexpected: ${err.message}`;
  return 'unexpected non-error throw';
}
