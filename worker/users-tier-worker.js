export default {
  async fetch(request, env) {
    const cors = buildCorsHeaders(request.headers.get("Origin"));
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === "/users/tiers" && request.method === "GET") {
        const result = await listUsers(env, url);
        return json(result, 200, cors);
      }

      if (url.pathname === "/users/tiers/upsert" && request.method === "POST") {
        const isAuthed = await isAdminAuthorized(request, env);
        if (!isAuthed) {
          return json({ ok: false, error: "Unauthorized" }, 401, cors);
        }

        const payload = await request.json();
        const saved = await upsertUserTier(env, payload);
        return json({ ok: true, user: saved }, 200, cors);
      }

      return json({ ok: false, error: "Not Found" }, 404, cors);
    } catch (error) {
      return json(
        { ok: false, error: error?.message || "Internal error" },
        500,
        cors
      );
    }
  },
};

function buildCorsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,x-admin-secret",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}

function normalizeTier(tier) {
  const raw = String(tier || "").trim().toLowerCase();
  if (raw === "vip") return "vip";
  if (raw === "premium") return "premium";
  if (raw === "standard" || raw === "standart") return "standart";
  return "standart";
}

function normalizeUser(user) {
  const id = String(user?.id || user?.email || crypto.randomUUID()).trim();
  return {
    id,
    name: String(user?.name || "").trim(),
    avatarUrl: String(user?.avatarUrl || "").trim(),
    tier: normalizeTier(user?.tier),
    updatedAt: new Date().toISOString(),
  };
}

async function listUsers(env, url) {
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 12)));

  // Main storage strategy: one JSON array under users:tiers
  const rawList = await env.USERS_KV.get("users:tiers", "json");
  let users = Array.isArray(rawList) ? rawList : [];

  // Optional legacy strategy: read ids from users:ids and records from user:<id>
  if (!users.length) {
    const legacyIds = await env.USERS_KV.get("users:ids", "json");
    if (Array.isArray(legacyIds) && legacyIds.length) {
      const records = await Promise.all(
        legacyIds.slice(0, limit).map((id) => env.USERS_KV.get(`user:${id}`, "json"))
      );
      users = records.filter(Boolean);
    }
  }

  const mapped = users
    .map(normalizeUser)
    .slice(0, limit)
    .map((u) => ({
      name: u.name || "User",
      tier: u.tier,
      avatarUrl: u.avatarUrl,
    }));

  return { ok: true, users: mapped };
}

async function upsertUserTier(env, payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Payload is required");
  }

  const entry = normalizeUser(payload);

  const rawList = await env.USERS_KV.get("users:tiers", "json");
  const users = Array.isArray(rawList) ? rawList : [];

  const index = users.findIndex((u) => String(u?.id || "") === entry.id);
  if (index >= 0) {
    users[index] = { ...users[index], ...entry };
  } else {
    users.unshift(entry);
  }

  await env.USERS_KV.put("users:tiers", JSON.stringify(users.slice(0, 200)));
  return entry;
}

async function isAdminAuthorized(request, env) {
  const headerSecret = request.headers.get("x-admin-secret") || "";
  let bodySecret = "";

  try {
    const clone = request.clone();
    const body = await clone.json();
    bodySecret = String(body?.secret || "");
  } catch {
    bodySecret = "";
  }

  const provided = headerSecret || bodySecret;
  return Boolean(env.ADMIN_SECRET) && provided === env.ADMIN_SECRET;
}
