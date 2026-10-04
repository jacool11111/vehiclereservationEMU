"use strict";
// Usage: npm run set-password -- <username> "<new password>"
// Creates the dispatcher if it does not exist, or changes its password.
const path = require("path"), fs = require("fs"), crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const [u, pw] = [(process.argv[2] || "").toLowerCase(), process.argv[3] || ""];
if (!u || pw.length < 6) { console.log('Usage: npm run set-password -- <username> "<password, min 6 chars>"'); process.exit(1); }
const dir = process.env.DATA_DIR || path.join(__dirname, "..", "data"); fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(path.join(dir, "emu.db"));
db.exec(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
const salt = crypto.randomBytes(12).toString("hex"), hash = crypto.scryptSync(pw, salt, 64).toString("hex");
if (db.prepare("SELECT 1 FROM admins WHERE username=?").get(u)) db.prepare("UPDATE admins SET salt=?,hash=? WHERE username=?").run(salt, hash, u);
else db.prepare("INSERT INTO admins(username,name,salt,hash) VALUES(?,?,?,?)").run(u, "Dispatcher", salt, hash);
db.prepare("DELETE FROM sessions WHERE username=?").run(u);
console.log(`Password set for dispatcher "${u}".`);
