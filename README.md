# Equipment Management Unit (NIA)

Vehicle availability and reservation system.
- **Dispatcher**: approves/rejects requests, re-selects vehicles, assigns drivers, manages vehicles, drivers and employee accounts, prints the monthly report.
- **Employee**: logs in with a username/password created by the dispatcher, checks availability (list + calendar) and sends vehicle requests.

## Roles
The dispatcher chooses each user's role in the **Accounts** tab (when creating the account, or later from the Role dropdown):

| Role | Can do |
|---|---|
| **Dispatcher** | Everything: approve/reject requests, assign drivers, change vehicles, manage vehicles/drivers/accounts, reports |
| **Employee** | Check availability (list + calendar) and send vehicle requests; see own requests |
| **Viewer** | Check availability only (no requests) |

### Restrictions per account
In **Accounts → Account restrictions** the dispatcher can limit any employee or viewer account. Changes apply immediately (no re-login needed) and are enforced by the server:

| Restriction | Effect |
|---|---|
| Can send vehicle requests | Off = the user can only view availability |
| Allowed vehicles | Employee can only request the ticked vehicles (none ticked = all) |
| Max days per request | Longer requests are refused |
| Max pending requests | Limits how many open requests a person can have |
| Hide driver names | Driver names are not sent to that user |
| Hide who is using vehicles and destinations | User sees only occupied/available dates |
| Access expires on | Account stops working after that date |

Set `APP_TZ` (default `Asia/Manila`) if the server is in another time zone, so expiry dates roll over at local midnight.

Log in with the tab that matches the role (Dispatcher tab for dispatchers, Employee tab for employees and viewers).
Changing a role signs that user out so the new role applies at next login. You cannot delete, disable or demote your own account.

No npm packages to install. The database is SQLite (file `data/emu.db`, created automatically).

## Included database
`data/emu.db` is a ready-to-use SQLite database (all tables created, no vehicles/drivers/accounts yet).
It already contains one dispatcher login: **dispatcher / ChangeMe123!** - change it right away:
`npm run set-password -- dispatcher "YourNewPassword"`
To start fresh at any time, delete `data/emu.db` (a new empty one is created on the next start).
`data/` is listed in `.gitignore`, so your live database is never uploaded to GitHub by accident.

## Requirements
- **Node.js 22.13 or newer** (https://nodejs.org)

## Run
```bash
npm start
```
Open http://localhost:3000

First run creates the dispatcher account (`dispatcher` / `ChangeMe123!`) and prints it in the console.
**Change the password immediately:**
```bash
npm run set-password -- dispatcher "YourNewPassword"
```
To choose your own first account: `ADMIN_USER=jane ADMIN_PASS="StrongPass1" npm start` (only used on first run).

## Settings (environment variables)
| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Port to listen on |
| `HOST` | 0.0.0.0 | Use `127.0.0.1` if behind a reverse proxy |
| `DATA_DIR` | ./data | Where `emu.db` is stored |
| `COOKIE_SECURE` | (off) | Set `1` when served over HTTPS |
| `TRUST_PROXY` | (off) | Set `1` behind nginx/Caddy (real client IP for login limits) |

## Deploy online (easiest ways)
The app needs a **persistent disk** for `data/emu.db`, otherwise reservations are erased on each restart/redeploy.
Free plans without a disk are NOT suitable.

**Option A - Render.com** (paid "Starter" plan with disk)
1. Push this folder to GitHub. In Render: New > Blueprint > pick the repository (it reads `render.yaml`).
2. Set `ADMIN_PASS` when asked. Deploy. Open the URL Render gives you and log in as Dispatcher.

**Option B - Railway.app**
1. New Project > Deploy from GitHub repo.
2. Add a **Volume** mounted at `/data`. Add variables: `DATA_DIR=/data`, `TRUST_PROXY=1`, `ADMIN_USER`, `ADMIN_PASS`.
3. Settings > Networking > Generate Domain.

**Option C - VPS / office PC** - see below (cheapest, full control).

Note: `ADMIN_USER` / `ADMIN_PASS` create the dispatcher account only the first time (empty database).
After that, change the password with `npm run set-password -- <user> "<new>"` (run it in the host's shell/console).

## Hosting on a server (Linux)
```bash
git clone https://github.com/jacool11111/EMUvehiclereservation.git
cd EMUvehiclereservation
npm install -g pm2
COOKIE_SECURE=1 TRUST_PROXY=1 HOST=127.0.0.1 pm2 start server.js --name emu --node-args="--no-warnings"
pm2 save && pm2 startup
```
Put nginx or Caddy in front for HTTPS (e.g. Caddy: `yourdomain.com { reverse_proxy 127.0.0.1:3000 }`).
For an office network only, running `npm start` on one PC is enough; employees open `http://<that-pc-ip>:3000`.

## Backup
Copy the file `data/emu.db`. Table layout is in `schema.sql`.

## Security notes
- Passwords are stored as scrypt hashes; sessions use HttpOnly cookies; login is rate limited.
- Permissions are enforced on the server (employees cannot reserve, approve, or read other people's requests).
- Use HTTPS if it is reachable outside your office network.

## Files
- `server.js` API + login + static hosting
- `schema.sql` database structure
- `public/index.html` the web app
- `scripts/set-password.js` change/create dispatcher password
