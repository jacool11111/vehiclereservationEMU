"use strict";
/* Equipment Management Unit - server. No npm packages needed (Node 22.13+). */
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = +process.env.PORT || 3000, HOST = process.env.HOST || "0.0.0.0";
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const PUB = path.join(__dirname, "public");
const SESSION_MS = 12 * 3600 * 1000;
fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(path.join(DATA, "emu.db"));
db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));

const st = {
  get: db.prepare("SELECT data FROM docs WHERE col=? AND id=?"),
  list: db.prepare("SELECT id,data FROM docs WHERE col=? ORDER BY id"),
  put: db.prepare("INSERT INTO docs(col,id,data) VALUES(?,?,?) ON CONFLICT(col,id) DO UPDATE SET data=excluded.data,updated_at=CURRENT_TIMESTAMP"),
  del: db.prepare("DELETE FROM docs WHERE col=? AND id=?"),
  admin: db.prepare("SELECT * FROM admins WHERE username=?"),
  addAdmin: db.prepare("INSERT INTO admins(username,name,salt,hash) VALUES(?,?,?,?)"),
  sesAdd: db.prepare("INSERT INTO sessions(token,role,username,name,expires) VALUES(?,?,?,?,?)"),
  sesGet: db.prepare("SELECT * FROM sessions WHERE token=?"),
  sesDel: db.prepare("DELETE FROM sessions WHERE token=?"),
  sesClean: db.prepare("DELETE FROM sessions WHERE expires<?"),
  sesDelUser: db.prepare("DELETE FROM sessions WHERE username=?"),
};

/* ---------- passwords (scrypt) ---------- */
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString("hex");
const verify = (pw, salt, hash) => {
  try { const a = Buffer.from(hashPw(pw, salt), "hex"), b = Buffer.from(hash, "hex"); return a.length === b.length && crypto.timingSafeEqual(a, b); } catch { return false; }
};
const newSalt = () => crypto.randomBytes(12).toString("hex");

/* seed first dispatcher */
if (!db.prepare("SELECT COUNT(*) c FROM admins").get().c) {
  const u = (process.env.ADMIN_USER || "dispatcher").toLowerCase(), p = process.env.ADMIN_PASS || "ChangeMe123!", s = newSalt();
  st.addAdmin.run(u, "Dispatcher", s, hashPw(p, s));
  console.log(`\n>>> First run: dispatcher account created.\n>>> Username: ${u}\n>>> Password: ${p}\n>>> CHANGE IT NOW:  npm run set-password -- ${u} "NewPassword"\n`);
}

/* ---------- helpers ---------- */
const json = (res, code, obj, extra = {}) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, no) => {
  let n = 0; const c = [];
  req.on("data", d => { n += d.length; if (n > 1e6) { no(Object.assign(new Error("Too large"), { code: 413 })); req.destroy(); } else c.push(d); });
  req.on("end", () => { try { ok(c.length ? JSON.parse(Buffer.concat(c).toString()) : {}); } catch { no(Object.assign(new Error("Invalid JSON"), { code: 400 })); } });
});
const cookie = h => { const o = {}; (h || "").split(";").forEach(x => { const i = x.indexOf("="); if (i > 0) o[x.slice(0, i).trim()] = x.slice(i + 1).trim(); }); return o; };
const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.APP_TZ || "Asia/Manila" });
const limitsOf = (a, role) => ({
  canRequest: role !== "viewer" && a.canRequest !== false,
  vehicleIds: Array.isArray(a.vehicleIds) ? a.vehicleIds : [],
  maxDays: +a.maxDays || 0, maxPending: +a.maxPending || 0,
  hideDrivers: !!a.hideDrivers, hideDetails: !!a.hideDetails, expires: a.expires || "",
});
function getUser(req) {
  const t = cookie(req.headers.cookie).sid; if (!t) return null;
  const s = st.sesGet.get(t); if (!s) return null;
  if (s.expires < Date.now()) { st.sesDel.run(t); return null; }
  const u = { token: t, role: s.role, username: s.username, name: s.name, limits: null };
  if (s.role !== "dispatcher") {          // employee / viewer: restrictions are read live from the account
    const r = st.get.get("accounts", s.username); const a = r ? JSON.parse(r.data) : null;
    if (!a || a.active === false || (a.expires && a.expires < todayStr())) { st.sesDel.run(t); return null; }
    u.limits = limitsOf(a, s.role);
  }
  return u;
}
const secure = req => process.env.COOKIE_SECURE === "1" || (process.env.TRUST_PROXY === "1" && req.headers["x-forwarded-proto"] === "https");
const fails = new Map();
const ipOf = req => (process.env.TRUST_PROXY === "1" && req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();

/* ---------- access rules ---------- */
const COLS = new Set(["vehicles", "drivers", "bookings", "requests", "accounts"]);
function allowed(user, col, id, method) {
  if (!user) return false;
  if (user.role === "dispatcher") return true;                       // dispatcher: everything
  if (user.role === "viewer") return method === "GET" && ["vehicles", "drivers", "bookings"].includes(col); // viewer: availability only
  if (["vehicles", "drivers", "bookings"].includes(col)) return method === "GET"; // employee: read-only availability
  if (col === "requests") return id === user.username && method !== "DELETE" && (method === "GET" || user.limits.canRequest); // employee: only own requests
  return false;
}
const clean = (col, d) => { if (col === "accounts") { const { salt, hash, ...r } = d; return r; } return d; };
function shape(user, col, d) {   // hide details from restricted employees
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
  data.items = out; return null;
}
function checkBooking(id, b) {
  if (!b.vehicleId || !b.start || !b.end || b.end < b.start) return "Invalid booking";
  for (const r of st.list.all("bookings")) {
    if (r.id === id) continue; const x = JSON.parse(r.data);
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
    data.salt = newSalt(); data.hash = hashPw(data.password, data.salt); delete data.password;
  } else if (oldData) { data.salt = oldData.salt; data.hash = oldData.hash; }
  delete data.password; return null;
}

/* ---------- API ---------- */
async function api(req, res, p) {
  const parts = p.split("/").filter(Boolean).slice(1), method = req.method;

  if (parts[0] === "login" && method === "POST") {
    const b = await readBody(req), ip = ipOf(req);
    const role = b.role === "dispatcher" ? "dispatcher" : "employee";
    const un = String(b.username || "").trim().toLowerCase(), pw = String(b.password || "");
    const key = ip + "|" + un, f = fails.get(key);
    if (f && f.until > Date.now()) return json(res, 429, { error: "Too many attempts. Try again in a few minutes." });
    let user = null, disabled = false;
    if (role === "dispatcher") { const a = st.admin.get(un); if (a && verify(pw, a.salt, a.hash)) user = { username: un, name: a.name, role: "dispatcher" }; }
    if (!user) {
      const r = st.get.get("accounts", un);
      if (r) {
        const a = JSON.parse(r.data), ar = a.role === "dispatcher" ? "dispatcher" : a.role === "viewer" ? "viewer" : "employee";
        if ((ar === "dispatcher") === (role === "dispatcher") && a.hash && verify(pw, a.salt, a.hash)) { if (a.active === false) disabled = true; else if (a.expires && a.expires < todayStr()) return json(res, 403, { error: "This account has expired. Contact the dispatcher." }); else user = { username: un, name: a.name, role: ar }; }
      }
    }
    if (disabled) return json(res, 403, { error: "This account is disabled. Contact the dispatcher." });
    if (!user) {
      const n = (f ? f.n : 0) + 1; fails.set(key, { n, until: n >= 5 ? Date.now() + 10 * 60000 : 0 });
      await new Promise(r => setTimeout(r, 400));
      return json(res, 401, { error: "Incorrect username or password." });
    }
    fails.delete(key); st.sesClean.run(Date.now());
    const t = crypto.randomBytes(32).toString("hex");
    st.sesAdd.run(t, user.role, user.username, user.name, Date.now() + SESSION_MS);
    return json(res, 200, { role: user.role, username: user.username, name: user.name, limits: user.role === "dispatcher" ? null : limitsOf(JSON.parse(st.get.get("accounts", user.username).data), user.role) },
      { "Set-Cookie": `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure(req) ? "; Secure" : ""}` });
  }
  if (parts[0] === "logout" && method === "POST") {
    const u = getUser(req); if (u) st.sesDel.run(u.token);
    return json(res, 200, { ok: true }, { "Set-Cookie": "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
  }
  if (parts[0] === "me" && method === "GET") {
    const u = getUser(req); return u ? json(res, 200, { role: u.role, username: u.username, name: u.name, limits: u.limits }) : json(res, 401, { error: "Not logged in" });
  }

  const col = parts[0], id = parts[1];
  if (!COLS.has(col) || parts.length > 2) return json(res, 404, { error: "Not found" });
  const user = getUser(req);
  if (!user) return json(res, 401, { error: "Please log in." });
  if (id !== undefined && !(col === "accounts" ? /^[a-z0-9][a-z0-9._-]{2,29}$/ : /^[A-Za-z0-9._-]{1,64}$/).test(id)) return json(res, 400, { error: "Invalid id" });
  if (!allowed(user, col, id, method)) return json(res, 403, { error: "You do not have permission to do that." });

  if (method === "GET") {
    const hide = user.limits && col === "drivers" && user.limits.hideDrivers;
    if (id === undefined) return json(res, 200, hide ? [] : st.list.all(col).map(r => ({ id: r.id, data: shape(user, col, clean(col, JSON.parse(r.data))) })));
    const r = hide ? null : st.get.get(col, id); return json(res, 200, { exists: !!r, data: r ? shape(user, col, clean(col, JSON.parse(r.data))) : null });
  }
  if (id === undefined) return json(res, 405, { error: "Method not allowed" });
  if (method === "DELETE") {
    if (col === "accounts" && id === user.username) return json(res, 400, { error: "You cannot delete your own account" });
    st.del.run(col, id); if (col === "accounts") st.sesDelUser.run(id); return json(res, 200, { ok: true });
  }
  if (method !== "PUT" && method !== "PATCH") return json(res, 405, { error: "Method not allowed" });

  const b = await readBody(req);
  if (!b || typeof b !== "object" || Array.isArray(b)) return json(res, 400, { error: "Invalid data" });
  const row = st.get.get(col, id), old = row ? JSON.parse(row.data) : null;
  let data = method === "PATCH" ? (old ? { ...old, ...b } : null) : b;
  if (!data) return json(res, 404, { error: "Not found" });
  let err = null;
  if (col === "accounts") {
    data.role = ["employee", "viewer", "dispatcher"].includes(data.role) ? data.role : "employee"; cleanLimits(data);
    if (id === user.username && (data.role !== "dispatcher" || data.active === false)) err = "You cannot disable or demote your own account";
    else if (!data.name) err = "Name required"; else if (!old && !data.password) err = "Password required"; else err = applyPassword(data, method === "PATCH" ? null : old); }
  else if (col === "bookings") err = checkBooking(id, data);
  else if (col === "requests" && user.role === "employee") err = checkEmployeeRequests(old, data, user);
  if (err) return json(res, err.startsWith("Vehicle already") || err.startsWith("Driver already") ? 409 : 400, { error: err });
  st.put.run(col, id, JSON.stringify(data));
  if (col === "accounts" && id !== user.username && old && (old.role !== data.role || old.active !== data.active || old.hash !== data.hash)) st.sesDelUser.run(id); // role/status/password change -> force re-login
  return json(res, 200, { ok: true });
}

/* ---------- static files ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
function serve(req, res, p) {
  const f = path.join(PUB, path.normalize(p === "/" ? "/index.html" : decodeURIComponent(p)));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" }); res.end(d);
  });
}

http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY"); res.setHeader("Referrer-Policy", "same-origin");
  try {
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/healthz") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }
    if (p.startsWith("/api/")) return await api(req, res, p);
    return serve(req, res, p);
  } catch (e) {
    if (e.code === 400 || e.code === 413) return json(res, e.code, { error: e.message });
    console.error(e); json(res, 500, { error: "Server error" });
  }
}).listen(PORT, HOST, () => console.log(`Equipment Management Unit running on http://localhost:${PORT}`));
