-- Equipment Management Unit - database schema (SQLite)
-- Created automatically by server.js on first run. Kept here for reference/backup.
PRAGMA journal_mode=WAL;

-- All records (vehicles, drivers, bookings, requests, accounts) stored as JSON documents.
--   col = vehicles | drivers | bookings | requests | accounts
--   vehicles : {name, plate}
--   drivers  : {name, phone}
--   bookings : {vehicleId, driverId, name, dest, purpose, start, end, userId, requestId}
--   requests : one row per employee username -> {items:[{id,vehicleId,name,dest,purpose,start,end,status,note,created}]}
--   accounts : employee logins -> {name, active, created, salt, hash}  (id = username)
CREATE TABLE IF NOT EXISTS docs(
  col TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(col,id)
);

-- Dispatcher logins (passwords stored as scrypt hashes, never plain text)
CREATE TABLE IF NOT EXISTS admins(
  username TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL
);

-- Login sessions
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  expires INTEGER NOT NULL
);
