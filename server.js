"use strict";
/* Equipment Management Unit - server.
 * Compatible with Neon PostgreSQL, Vercel Serverless, and local environments.
 */
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

const IS_VERCEL = !!process.env.VERCEL;
const PORT = +process.env.PORT || 3000, HOST = process.env.HOST || "0.0.0.0";
const DATA = process.env.DATA_DIR || (IS_VERCEL ? "/tmp" : path.join(__dirname, "data"));
const PUB = path.join(process.cwd(), "public");
const SESSION_MS = 12 * 3600 * 1000;

try {
  fs.mkdirSync(DATA, { recursive: true });
} catch (e) {
  // Safe ignore on read-only environments
}

/* ---------- Neon PostgreSQL setup ---------- */
const NEON_CONN = process.env.DATABASE_URL || process.env.POSTGRES_URL || "postgresql://neondb_owner:npg_ueKLTn6brXM9@ep-icy-wildflower-b8hs5k30-pooler.c-14.us-east-1.aws.neon.tech/neondb?channel_binding=require&sslmode=require";

async function neonQuery(query, params = []) {
  const urlObj = new URL(NEON_CONN);
  const endpoint = `https://${urlObj.host}/sql`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": NEON_CONN
    },
    body: JSON.stringify({ query, params })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Neon DB error (${res.status}): ${errText}`);
  }
  const json = await res.json();
  return json.rows || [];
}

const neonSt = {
  init: async () => {
    await neonQuery("CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(col,id));");
    await neonQuery("CREATE TABLE IF NOT EXISTS admins (username TEXT PRIMARY KEY, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);");
    await neonQuery("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, role TEXT NOT NULL, username TEXT NOT NULL, name TEXT NOT NULL, expires BIGINT NOT NULL);");
  },
  countAdmins: async () => {
    const rows = await neonQuery("SELECT COUNT(*) AS c FROM admins;");
    return rows[0] ? +rows[0].c : 0;
  },
  get: {
    get: async (col, id) => {
      const rows = await neonQuery("SELECT data FROM docs WHERE col=$1 AND id=$2;", [col, id]);
      return rows[0] ? { data: rows[0].data } : null;
    }
  },
  list: {
    all: async (col) => {
      const rows = await neonQuery("SELECT id, data FROM docs WHERE col=$1 ORDER BY id;", [col]);
      return rows.map(r => ({ id: r.id, data: r.data }));
    }
  },
  put: {
    run: async (col, id, data) => {
      await neonQuery("INSERT INTO docs(col, id, data) VALUES($1, $2, $3) ON CONFLICT(col, id) DO UPDATE SET data=EXCLUDED.data, updated_at=CURRENT_TIMESTAMP;", [col, id, data]);
    }
  },
  del: {
    run: async (col, id) => {
      await neonQuery("DELETE FROM docs WHERE col=$1 AND id=$2;", [col, id]);
    }
  },
  admin: {
    get: async (un) => {
      const rows = await neonQuery("SELECT * FROM admins WHERE username=$1;", [un]);
      return rows[0] || null;
    }
  },
  addAdmin: {
    run: async (username, name, salt, hash) => {
      await neonQuery("INSERT INTO admins(username, name, salt, hash) VALUES($1, $2, $3, $4) ON CONFLICT(username) DO NOTHING;", [username, name, salt, hash]);
    }
  },
  sesAdd: {
    run: async (token, role, username, name, expires) => {
      await neonQuery("INSERT INTO sessions(token, role, username, name, expires) VALUES($1, $2, $3, $4, $5);", [token, role, username, name, expires]);
    }
  },
  sesGet: {
    get: async (t) => {
      const rows = await neonQuery("SELECT * FROM sessions WHERE token=$1;", [t]);
      return rows[0] || null;
    }
  },
  sesDel: {
    run: async (t) => {
      await neonQuery("DELETE FROM sessions WHERE token=$1;", [t]);
    }
  },
  sesClean: {
    run: async (now) => {
      await neonQuery("DELETE FROM sessions WHERE expires < $1;", [now]);
    }
  },
  sesDelUser: {
    run: async (un) => {
      await neonQuery("DELETE FROM sessions WHERE username=$1;", [un]);
    }
  }
};

/* ---------- Fallback local store (if NEON_CONN is unset) ---------- */
const storeFile = path.join(DATA, "emu_store.json");
let store = { docs: {}, admins: {}, sessions: {} };

function loadStore() {
  try {
    if (fs.existsSync(storeFile)) {
      const parsed = JSON.parse(fs.readFileSync(storeFile, "utf8"));
      if (parsed) {
        store.docs = parsed.docs || {};
        store.admins = parsed.admins || {};
        store.sessions = parsed.sessions || {};
      }
    }
  } catch (e) {}
}

function saveStore() {
  try {
    fs.writeFileSync(storeFile, JSON.stringify(store));
  } catch (e) {}
}

const fallbackSt = {
  init: async () => loadStore(),
  countAdmins: async () => {
    loadStore();
    return Object.keys(store.admins).length;
  },
  get: {
    get: async (col, id) => {
      loadStore();
      const val = store.docs[`${col}:${id}`];
      return val !== undefined ? { data: val } : null;
    }
  },
  list: {
    all: async (col) => {
      loadStore();
      const prefix = `${col}:`;
      const out = [];
      for (const k of Object.keys(store.docs)) {
        if (k.startsWith(prefix)) {
          out.push({ id: k.slice(prefix.length), data: store.docs[k] });
        }
      }
      out.sort((a, b) => a.id.localeCompare(b.id));
      return out;
    }
  },
  put: {
    run: async (col, id, data) => {
      loadStore();
      store.docs[`${col}:${id}`] = data;
      saveStore();
    }
  },
  del: {
    run: async (col, id) => {
      loadStore();
      delete store.docs[`${col}:${id}`];
      saveStore();
    }
  },
  admin: {
    get: async (un) => {
      loadStore();
      return store.admins[un] || null;
    }
  },
  addAdmin: {
    run: async (username, name, salt, hash) => {
      loadStore();
      store.admins[username] = { username, name, salt, hash };
      saveStore();
    }
  },
  sesAdd: {
    run: async (token, role, username, name, expires) => {
      loadStore();
      store.sessions[token] = { token, role, username, name, expires };
      saveStore();
    }
  },
  sesGet: {
    get: async (t) => {
      loadStore();
      return store.sessions[t] || null;
    }
  },
  sesDel: {
    run: async (t) => {
      loadStore();
      delete store.sessions[t];
      saveStore();
    }
  },
  sesClean: {
    run: async (now) => {
      loadStore();
      let ch = false;
      for (const t of Object.keys(store.sessions)) {
        if (store.sessions[t].expires < now) { delete store.sessions[t]; ch = true; }
      }
      if (ch) saveStore();
    }
  },
  sesDelUser: {
    run: async (un) => {
      loadStore();
      let ch = false;
      for (const t of Object.keys(store.sessions)) {
        if (store.sessions[t].username === un) { delete store.sessions[t]; ch = true; }
      }
      if (ch) saveStore();
    }
  }
};

const st = NEON_CONN ? neonSt : fallbackSt;

/* ---------- passwords (scrypt) ---------- */
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString("hex");
const verify = (pw, salt, hash) => {
  try {
    const a = Buffer.from(hashPw(pw, salt), "hex"), b = Buffer.from(hash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
};
const newSalt = () => crypto.randomBytes(12).toString("hex");

/* ---------- seed dispatcher on initialization ---------- */
let initPromise = null;
function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      await st.init();
      const count = await st.countAdmins();
      if (count === 0) {
        const u = (process.env.ADMIN_USER || "dispatcher").toLowerCase();
        const p = process.env.ADMIN_PASS || "ChangeMe123!";
        const s = newSalt();
        await st.addAdmin.run(u, "Dispatcher", s, hashPw(p, s));
        console.log(`\n>>> Dispatcher account created: ${u} / ${p}\n`);
      }
    })().catch(e => {
      initPromise = null;
      console.error("Initialization error:", e);
      throw e;
    });
  }
  return initPromise;
}

/* ---------- helpers ---------- */
const json = (res, code, obj, extra = {}) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra });
  res.end(JSON.stringify(obj));
};

const readBody = req => {
  if (req.body !== undefined) {
    if (typeof req.body === "string") {
      try { return Promise.resolve(JSON.parse(req.body)); } catch { return Promise.reject(Object.assign(new Error("Invalid JSON"), { code: 400 })); }
    }
    return Promise.resolve(req.body || {});
  }
  return new Promise((ok, no) => {
    let n = 0; const c = [];
    req.on("data", d => {
      n += d.length;
      if (n > 1e6) { no(Object.assign(new Error("Too large"), { code: 413 })); req.destroy(); }
      else c.push(d);
    });
    req.on("end", () => {
      try { ok(c.length ? JSON.parse(Buffer.concat(c).toString()) : {}); }
      catch { no(Object.assign(new Error("Invalid JSON"), { code: 400 })); }
    });
    req.on("error", no);
  });
};

const cookie = h => {
  const o = {};
  (h || "").split(";").forEach(x => {
    const i = x.indexOf("=");
    if (i > 0) o[x.slice(0, i).trim()] = x.slice(i + 1).trim();
  });
  return o;
};

const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.APP_TZ || "Asia/Manila" });

const limitsOf = (a, role) => ({
  canRequest: role !== "viewer" && a.canRequest !== false,
  vehicleIds: Array.isArray(a.vehicleIds) ? a.vehicleIds : [],
  maxDays: +a.maxDays || 0, maxPending: +a.maxPending || 0,
  hideDrivers: !!a.hideDrivers, hideDetails: !!a.hideDetails, expires: a.expires || "",
});

async function getUser(req) {
  const t = cookie(req.headers.cookie).sid;
  if (!t) return null;
  const s = await st.sesGet.get(t);
  if (!s) return null;
  if (+s.expires < Date.now()) {
    await st.sesDel.run(t);
    return null;
  }
  const u = { token: t, role: s.role, username: s.username, name: s.name, limits: null };
  if (s.role !== "dispatcher") {
    const r = await st.get.get("accounts", s.username);
    const a = r ? JSON.parse(r.data) : null;
    if (!a || a.active === false || (a.expires && a.expires < todayStr())) {
      await st.sesDel.run(t);
      return null;
    }
    u.limits = limitsOf(a, s.role);
  }
  return u;
}

const secure = req => process.env.COOKIE_SECURE === "1" || IS_VERCEL || (process.env.TRUST_PROXY === "1" && req.headers["x-forwarded-proto"] === "https");
const fails = new Map();
const ipOf = req => ((process.env.TRUST_PROXY === "1" || IS_VERCEL) && req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString().split(",")[0].trim();

/* ---------- access rules ---------- */
const COLS = new Set(["vehicles", "drivers", "bookings", "requests", "accounts"]);

function allowed(user, col, id, method) {
  if (!user) return false;
  if (user.role === "dispatcher") return true;
  if (user.role === "viewer") return method === "GET" && ["vehicles", "drivers", "bookings"].includes(col);
  if (["vehicles", "drivers", "bookings"].includes(col)) return method === "GET";
  if (col === "requests") return id === user.username && method !== "DELETE" && (method === "GET" || user.limits.canRequest);
  return false;
}

const clean = (col, d) => {
  if (col === "accounts") {
    const { salt, hash, ...r } = d;
    return r;
  }
  return d;
};

function shape(user, col, d) {
  if (col !== "bookings" || !user.limits) return d;
  if (user.limits.hideDetails) return { vehicleId: d.vehicleId, start: d.start, end: d.end };
  if (user.limits.hideDrivers) { const { driverId, ...r } = d; return r; }
  return d;
}

function cleanLimits(d) {
  if ("canRequest" in d) d.canRequest = d.canRequest !== false;
  if ("hideDrivers" in d) d.hideDrivers = !!d.hideDrivers;
  if ("hideDetails" in d) d.hideDetails = !!d.hideDetails;
  if ("vehicleIds" in d) d.vehicleIds = Array.isArray(d.vehicleIds) ? d.vehicleIds.filter(x => typeof x === "string").slice(0, 200) : [];
  if ("maxDays" in d) d.maxDays = Math.max(0, Math.min(365, parseInt(d.maxDays) || 0));
  if ("maxPending" in d) d.maxPending = Math.max(0, Math.min(100, parseInt(d.maxPending) || 0));
  if ("expires" in d) d.expires = /^\d{4}-\d{2}-\d{2}$/.test(d.expires) ? d.expires : "";
}

const stable = o => JSON.stringify(o, Object.keys(o).sort());

function checkEmployeeRequests(oldData, data, user) {
  if (!data || !Array.isArray(data.items) || data.items.length > 300) return "Invalid request data";
  const L = user.limits;
  const old = new Map(((oldData && oldData.items) || []).map(i => [i.id, i]));
  const out = [];
  for (const it of data.items) {
    const o = old.get(it.id);
    if (o) { if (stable(o) !== stable(it)) return "You cannot change an existing request"; out.push(o); continue; }
    if (it.status !== "pending" || (it.note || "") !== "") return "New requests must be pending";
    if (!/^[\w-]{1,40}$/.test(it.id || "") || !it.vehicleId || !it.dest || !/^\d{4}-\d{2}-\d{2}$/.test(it.start) || !/^\d{4}-\d{2}-\d{2}$/.test(it.end) || it.end < it.start) return "Invalid request fields";
    if (!L.canRequest) return "Your account is not allowed to send requests";
    if (L.vehicleIds.length && !L.vehicleIds.includes(it.vehicleId)) return "You are not allowed to request that vehicle";
    const nd = Math.round((Date.parse(it.end) - Date.parse(it.start)) / 864e5) + 1;
    if (L.maxDays && nd > L.maxDays) return `Requests are limited to ${L.maxDays} day(s)`;
    if (L.maxPending && out.filter(x => x.status === "pending").length >= L.maxPending) return `You can only have ${L.maxPending} pending request(s) at a time`;
    out.push({ id: it.id, vehicleId: String(it.vehicleId).slice(0, 64), name: user.name, dest: String(it.dest).slice(0, 200), purpose: String(it.purpose || "").slice(0, 200), start: it.start, end: it.end, status: "pending", note: "", created: String(it.created || new Date().toISOString()) });
  }
  for (const [id, o] of old) if (!data.items.find(i => i.id === id) && o.status !== "pending") return "You cannot remove a processed request";
  data.items = out;
  return null;
}

async function checkBooking(id, b) {
  if (!b.vehicleId || !b.start || !b.end || b.end < b.start) return "Invalid booking";
  const allBookings = await st.list.all("bookings");
  for (const r of allBookings) {
    if (r.id === id) continue;
    const x = JSON.parse(r.data);
    if (x.start <= b.end && b.start <= x.end) {
      if (x.vehicleId === b.vehicleId) return `Vehicle already occupied (${x.start} to ${x.end})`;
      if (b.driverId && x.driverId === b.driverId) return `Driver already assigned (${x.start} to ${x.end})`;
    }
  }
  return null;
}

function applyPassword(data, oldData) {
  if (typeof data.password === "string") {
    if (data.password.length < 6) return "Password must be at least 6 characters";
    data.salt = newSalt();
    data.hash = hashPw(data.password, data.salt);
    delete data.password;
  } else if (oldData) {
    data.salt = oldData.salt;
    data.hash = oldData.hash;
  }
  delete data.password;
  return null;
}

/* ---------- API Handler ---------- */
async function api(req, res, p) {
  let subPath = p;
  if (subPath.startsWith("/api")) subPath = subPath.slice(4);
  const parts = subPath.split("/").filter(Boolean), method = req.method;

  if (parts[0] === "login" && method === "POST") {
    const b = await readBody(req), ip = ipOf(req);
    const role = b.role === "dispatcher" ? "dispatcher" : "employee";
    const un = String(b.username || "").trim().toLowerCase(), pw = String(b.password || "");
    const key = ip + "|" + un, f = fails.get(key);
    if (f && f.until > Date.now()) return json(res, 429, { error: "Too many attempts. Try again in a few minutes." });
    let user = null, disabled = false;
    if (role === "dispatcher") {
      const a = await st.admin.get(un);
      if (a && verify(pw, a.salt, a.hash)) user = { username: un, name: a.name, role: "dispatcher" };
    }
    if (!user) {
      const r = await st.get.get("accounts", un);
      if (r) {
        const a = JSON.parse(r.data), ar = a.role === "dispatcher" ? "dispatcher" : a.role === "viewer" ? "viewer" : "employee";
        if ((ar === "dispatcher") === (role === "dispatcher") && a.hash && verify(pw, a.salt, a.hash)) {
          if (a.active === false) disabled = true;
          else if (a.expires && a.expires < todayStr()) return json(res, 403, { error: "This account has expired. Contact the dispatcher." });
          else user = { username: un, name: a.name, role: ar };
        }
      }
    }
    if (disabled) return json(res, 403, { error: "This account is disabled. Contact the dispatcher." });
    if (!user) {
      const n = (f ? f.n : 0) + 1;
      fails.set(key, { n, until: n >= 5 ? Date.now() + 10 * 60000 : 0 });
      await new Promise(r => setTimeout(r, 400));
      return json(res, 401, { error: "Incorrect username or password." });
    }
    fails.delete(key);
    await st.sesClean.run(Date.now());
    const t = crypto.randomBytes(32).toString("hex");
    await st.sesAdd.run(t, user.role, user.username, user.name, Date.now() + SESSION_MS);
    const userAccRow = user.role === "dispatcher" ? null : await st.get.get("accounts", user.username);
    const userLimits = userAccRow ? limitsOf(JSON.parse(userAccRow.data), user.role) : null;
    return json(res, 200, { role: user.role, username: user.username, name: user.name, limits: userLimits },
      { "Set-Cookie": `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure(req) ? "; Secure" : ""}` });
  }

  if (parts[0] === "logout" && method === "POST") {
    const u = await getUser(req);
    if (u) await st.sesDel.run(u.token);
    return json(res, 200, { ok: true }, { "Set-Cookie": "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
  }

  if (parts[0] === "me" && method === "GET") {
    const u = await getUser(req);
    return u ? json(res, 200, { role: u.role, username: u.username, name: u.name, limits: u.limits }) : json(res, 401, { error: "Not logged in" });
  }

  const col = parts[0], id = parts[1];
  if (!COLS.has(col) || parts.length > 2) return json(res, 404, { error: "Not found" });
  const user = await getUser(req);
  if (!user) return json(res, 401, { error: "Please log in." });
  if (id !== undefined && !(col === "accounts" ? /^[a-z0-9][a-z0-9._-]{2,29}$/ : /^[A-Za-z0-9._-]{1,64}$/).test(id)) return json(res, 400, { error: "Invalid id" });
  if (!allowed(user, col, id, method)) return json(res, 403, { error: "You do not have permission to do that." });

  if (method === "GET") {
    const hide = user.limits && col === "drivers" && user.limits.hideDrivers;
    if (id === undefined) {
      const list = await st.list.all(col);
      return json(res, 200, hide ? [] : list.map(r => ({ id: r.id, data: shape(user, col, clean(col, JSON.parse(r.data))) })));
    }
    const r = hide ? null : await st.get.get(col, id);
    return json(res, 200, { exists: !!r, data: r ? shape(user, col, clean(col, JSON.parse(r.data))) : null });
  }

  if (id === undefined) return json(res, 405, { error: "Method not allowed" });

  if (method === "DELETE") {
    if (col === "accounts" && id === user.username) return json(res, 400, { error: "You cannot delete your own account" });
    await st.del.run(col, id);
    if (col === "accounts") await st.sesDelUser.run(id);
    return json(res, 200, { ok: true });
  }

  if (method !== "PUT" && method !== "PATCH") return json(res, 405, { error: "Method not allowed" });

  const b = await readBody(req);
  if (!b || typeof b !== "object" || Array.isArray(b)) return json(res, 400, { error: "Invalid data" });
  const row = await st.get.get(col, id);
  const old = row ? JSON.parse(row.data) : null;
  let data = method === "PATCH" ? (old ? { ...old, ...b } : null) : b;
  if (!data) return json(res, 404, { error: "Not found" });
  let err = null;
  if (col === "accounts") {
    data.role = ["employee", "viewer", "dispatcher"].includes(data.role) ? data.role : "employee";
    cleanLimits(data);
    if (id === user.username && (data.role !== "dispatcher" || data.active === false)) err = "You cannot disable or demote your own account";
    else if (!data.name) err = "Name required";
    else if (!old && !data.password) err = "Password required";
    else err = applyPassword(data, method === "PATCH" ? null : old);
  }
  else if (col === "bookings") err = await checkBooking(id, data);
  else if (col === "requests" && user.role === "employee") err = checkEmployeeRequests(old, data, user);
  if (err) return json(res, err.startsWith("Vehicle already") || err.startsWith("Driver already") ? 409 : 400, { error: err });
  await st.put.run(col, id, JSON.stringify(data));
  if (col === "accounts" && id !== user.username && old && (old.role !== data.role || old.active !== data.active || old.hash !== data.hash)) await st.sesDelUser.run(id);
  return json(res, 200, { ok: true });
}

/* ---------- static files ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
function serve(req, res, p) {
  const normPath = path.normalize(p === "/" ? "/index.html" : decodeURIComponent(p));
  const f = path.join(PUB, normPath);
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) {
      const indexFile = path.join(PUB, "index.html");
      return fs.readFile(indexFile, (err, indexData) => {
        if (err) { res.writeHead(404); return res.end("Not found"); }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        res.end(indexData);
      });
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(d);
  });
}

async function handler(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  try {
    await ensureInit();
    const rawPath = req.url ? new URL(req.url, "http://x").pathname : "/";
    if (rawPath === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }
    if (rawPath.startsWith("/api/") || rawPath === "/api") {
      return await api(req, res, rawPath);
    }
    return serve(req, res, rawPath);
  } catch (e) {
    if (e.code === 400 || e.code === 413) return json(res, e.code, { error: e.message });
    console.error("Handler error:", e);
    json(res, 500, { error: "Server error", detail: e.message });
  }
}

if (!IS_VERCEL) {
  http.createServer(handler).listen(PORT, HOST, () =>
    console.log(`Equipment Management Unit running on http://localhost:${PORT}`)
  );
}

module.exports = handler;
