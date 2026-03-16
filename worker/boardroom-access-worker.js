/**
 * Boardroom Access Worker — sitecode.store
 *
 * KV binding: USERS_KV
 * Secret env var: ADMIN_SECRET (set via: wrangler secret put ADMIN_SECRET)
 *
 * ── Endpoints ──────────────────────────────────────────────
 *  POST /br/grant   — admin grants Board Room access to an email
 *  POST /br/revoke  — admin revokes Board Room access
 *  POST /br/check   — check if email has access; returns signed token
 *  POST /br/verify  — verify a previously issued token (no email param needed)
 *  GET  /br/list    — admin: list all users with Board Room access
 *
 * ── Page gate (when deployed as a Cloudflare route) ────────
 *  GET  /preview-corp-board.html
 *       Checks Cookie "br_session" or query param ?br_token=
 *       → authorized:   proxies the page from origin + sets cookie
 *       → unauthorized: redirects to https://sitecode.store/index.html
 *
 * ── KV schema ──────────────────────────────────────────────
 *  br:access:<email>  →  { access, email, user_role, grantedAt, grantedBy }
 *
 * ── wrangler.toml (example) ────────────────────────────────
 *  name = "boardroom-access"
 *  main = "worker/boardroom-access-worker.js"
 *  compatibility_date = "2024-01-01"
 *
 *  [[kv_namespaces]]
 *  binding = "USERS_KV"
 *  id = "<your-kv-namespace-id>"
 *
 *  # Route that intercepts the boardroom page on production:
 *  [[routes]]
 *  pattern = "sitecode.store/preview-corp-board.html"
 *  zone_name = "sitecode.store"
 */

const BOARDROOM_URL = 'https://sitecode.store/preview-corp-board.html';
const HOME_URL      = 'https://sitecode.store/index.html';
/** Signed token max age — 7 days */
const TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

export default {
  async fetch(request, env) {
    const cors = buildCorsHeaders(request.headers.get('Origin'));
    const url  = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const path = url.pathname;

      // ── Page gate ──────────────────────────────────────────
      if (
        (path === '/preview-corp-board.html' || path === '/boardroom') &&
        request.method === 'GET'
      ) {
        return await handlePageGate(request, env, url);
      }

      // ── API routes ─────────────────────────────────────────
      if (path === '/br/check'  && request.method === 'POST') return await handleCheck(request, env, cors);
      if (path === '/br/grant'  && request.method === 'POST') return await handleGrant(request, env, cors);
      if (path === '/br/revoke' && request.method === 'POST') return await handleRevoke(request, env, cors);
      if (path === '/br/verify' && request.method === 'POST') return await handleVerify(request, env, cors);
      if (path === '/br/list'   && request.method === 'GET')  return await handleList(request, env, cors);

      return json({ ok: false, error: 'Not Found' }, 404, cors);
    } catch (err) {
      return json({ ok: false, error: err?.message || 'Internal error' }, 500, cors);
    }
  },
};

// ── Page gate ─────────────────────────────────────────────────────────────────

async function handlePageGate(request, env, url) {
  // 1. Check HttpOnly session cookie (set by this Worker on prior authorized visit)
  const cookieHeader = request.headers.get('Cookie') || '';
  const brSession = parseCookies(cookieHeader)['br_session'];
  if (brSession) {
    const claims = await verifyToken(brSession, env.ADMIN_SECRET);
    if (claims) {
      // Still valid — proxy the page transparently
      return proxyPage(request, url);
    }
  }

  // 2. Check one-time ?br_token= query param (issued by /br/check after login)
  const qToken = url.searchParams.get('br_token');
  if (qToken) {
    const claims = await verifyToken(qToken, env.ADMIN_SECRET);
    if (claims) {
      // Valid token — proxy the page and set a durable session cookie
      const cleanUrl = new URL(request.url);
      cleanUrl.searchParams.delete('br_token');
      const response = await fetch(cleanUrl.toString(), {
        headers: request.headers,
        cf: { cacheEverything: false },
      });
      const proxied = new Response(response.body, response);
      proxied.headers.append(
        'Set-Cookie',
        `br_session=${qToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`,
      );
      return proxied;
    }
  }

  // 3. Not authorized — redirect to home
  return Response.redirect(HOME_URL, 302);
}

async function proxyPage(request, url) {
  const proxyUrl = new URL(request.url);
  proxyUrl.searchParams.delete('br_token');
  return fetch(proxyUrl.toString(), {
    headers: request.headers,
    cf: { cacheEverything: false },
  });
}

// ── /br/check ─────────────────────────────────────────────────────────────────

async function handleCheck(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const email = normalizeEmail(body?.email);
  if (!email) return json({ ok: false, access: false, error: 'email required' }, 400, cors);

  const entry = await env.USERS_KV.get(`br:access:${email}`, 'json');
  if (!entry || !entry.access) {
    return json({ ok: true, access: false }, 200, cors);
  }

  // Issue a signed session token
  const token = await signToken(email, env.ADMIN_SECRET);
  return json(
    {
      ok: true,
      access: true,
      token,
      role: entry.user_role || 'vip',
      // Convenience: the redirect URL the client can use to open the page via the Worker gate
      gateUrl: `${BOARDROOM_URL}?br_token=${token}`,
    },
    200,
    cors,
  );
}

// ── /br/verify ────────────────────────────────────────────────────────────────

async function handleVerify(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const token = String(body?.token || '').trim();
  if (!token) return json({ ok: false, authorized: false, error: 'token required' }, 400, cors);

  const claims = await verifyToken(token, env.ADMIN_SECRET);
  if (!claims) return json({ ok: true, authorized: false }, 200, cors);

  // Double-check KV in case access was revoked after the token was issued
  const entry = await env.USERS_KV.get(`br:access:${claims.email}`, 'json');
  const stillValid = !!(entry && entry.access);

  return json({ ok: true, authorized: stillValid, email: claims.email, role: entry?.user_role || 'vip' }, 200, cors);
}

// ── /br/grant ─────────────────────────────────────────────────────────────────

async function handleGrant(request, env, cors) {
  const isAdmin = await isAdminAuthorized(request, env);
  if (!isAdmin) return json({ ok: false, error: 'Unauthorized' }, 401, cors);

  const body = await request.json().catch(() => ({}));
  const email = normalizeEmail(body?.email);
  if (!email) return json({ ok: false, error: 'email required' }, 400, cors);

  const allowedRoles = ['vip', 'premium', 'standart'];
  const role = allowedRoles.includes(body?.user_role) ? body.user_role : 'vip';

  await env.USERS_KV.put(
    `br:access:${email}`,
    JSON.stringify({
      access: true,
      email,
      user_role: role,
      grantedAt: new Date().toISOString(),
      grantedBy: String(body?.grantedBy || 'admin').slice(0, 64),
    }),
  );

  return json({ ok: true, email, user_role: role }, 200, cors);
}

// ── /br/revoke ────────────────────────────────────────────────────────────────

async function handleRevoke(request, env, cors) {
  const isAdmin = await isAdminAuthorized(request, env);
  if (!isAdmin) return json({ ok: false, error: 'Unauthorized' }, 401, cors);

  const body = await request.json().catch(() => ({}));
  const email = normalizeEmail(body?.email);
  if (!email) return json({ ok: false, error: 'email required' }, 400, cors);

  await env.USERS_KV.delete(`br:access:${email}`);
  return json({ ok: true, email }, 200, cors);
}

// ── /br/list ──────────────────────────────────────────────────────────────────

async function handleList(request, env, cors) {
  const isAdmin = await isAdminAuthorized(request, env);
  if (!isAdmin) return json({ ok: false, error: 'Unauthorized' }, 401, cors);

  const listed = await env.USERS_KV.list({ prefix: 'br:access:' });
  const entries = await Promise.all(
    listed.keys.map(async ({ name }) => {
      const val = await env.USERS_KV.get(name, 'json');
      return val;
    }),
  );

  return json({ ok: true, users: entries.filter(Boolean) }, 200, cors);
}

// ── HMAC token helpers ────────────────────────────────────────────────────────

/**
 * Creates a signed token: base64url( email|timestamp|hmac_hex )
 */
async function signToken(email, secret) {
  const ts      = Date.now();
  const payload = `${email}|${ts}`;
  const key     = await importHmacKey(secret, ['sign']);
  const sig     = await crypto.subtle.sign('HMAC', key, encode(payload));
  const sigHex  = toHex(new Uint8Array(sig));
  return toBase64url(`${payload}|${sigHex}`);
}

/**
 * Verifies a token. Returns { email, ts } on success, null on failure.
 */
async function verifyToken(token, secret, maxAge = TOKEN_MAX_AGE) {
  try {
    const decoded = fromBase64url(token);
    const lastPipe = decoded.lastIndexOf('|');
    if (lastPipe < 0) return null;

    const payload = decoded.slice(0, lastPipe);
    const sigHex  = decoded.slice(lastPipe + 1);

    const firstPipe = payload.indexOf('|');
    if (firstPipe < 0) return null;

    const email = payload.slice(0, firstPipe);
    const ts    = Number(payload.slice(firstPipe + 1));

    if (!email || !ts || isNaN(ts))     return null;
    if (Date.now() - ts > maxAge)       return null;

    const key      = await importHmacKey(secret, ['verify']);
    const sigBytes = fromHex(sigHex);
    const valid    = await crypto.subtle.verify('HMAC', key, sigBytes, encode(payload));

    return valid ? { email, ts } : null;
  } catch {
    return null;
  }
}

async function importHmacKey(secret, usages) {
  return crypto.subtle.importKey(
    'raw',
    encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

// ── Utility ────────────────────────────────────────────────────────────────────

function normalizeEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  // Basic format guard — no regex injection, just sanity check
  return e.includes('@') && e.length <= 254 ? e : '';
}

async function isAdminAuthorized(request, env) {
  const headerSecret = request.headers.get('x-admin-secret') || '';
  if (headerSecret && headerSecret === env.ADMIN_SECRET) return true;
  // Also accept secret in body (for admin panel POST requests)
  const body = await request.clone().json().catch(() => ({}));
  return String(body?.secret || '') === env.ADMIN_SECRET;
}

function parseCookies(header) {
  return Object.fromEntries(
    header.split(';')
      .map(c => c.trim())
      .filter(Boolean)
      .map(c => {
        const eq = c.indexOf('=');
        return eq < 0 ? [c, ''] : [c.slice(0, eq).trim(), c.slice(eq + 1)];
      }),
  );
}

function buildCorsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin':  origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,x-admin-secret',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}

function encode(str) {
  return new TextEncoder().encode(str);
}

function toHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const pairs = hex.match(/.{1,2}/g) || [];
  return new Uint8Array(pairs.map(h => parseInt(h, 16)));
}

function toBase64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromBase64url(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return atob(b64);
}
