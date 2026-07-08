# ProcessGuard Andon

ProcessGuard Andon is a modern internal manufacturing command and live alert system.

It is built for the workflow you described:

```text
Operator presses one command button
-> the command can create alerts for multiple departments
-> each department page sees only its own work
-> each physical M5 pager receives only its own department alerts
-> managers see the command grouped in a split-screen live floor card
```

The app is intentionally not a copy of the old `/andon/...` path structure. The optimized browser paths are:

```text
/login
/operator
/queue
/floor
/reports
/admin
```

The old pager paths are kept for compatibility with your current `app_main.c` firmware:

```text
GET  /api/andon/pager/alerts/active
POST /api/andon/pager/alerts/:id/acknowledge
POST /api/andon/pager/alerts/:id/arrive
POST /api/andon/pager/alerts/:id/resolve
```

## Tech stack

- Node.js API server
- Fastify
- React
- Vite
- TypeScript
- PostgreSQL
- Prisma ORM
- Socket.IO realtime refresh
- TanStack Query frontend cache
- Browser-local draggable/resizable sidebar preferences

## Main concepts

### Command

A command is the thing the operator creates. Example: `Quality Hold`.

### Department alert

A command creates one alert per target department. Example:

```text
Quality Hold command
  -> Quality alert
  -> Supervisor alert
```

Quality can acknowledge and resolve the Quality alert. Supervisor can acknowledge and resolve the Supervisor alert. The manager sees both under one grouped command.

### Command template

Admin-configured quick button. Example:

```text
Button: Material Clear
Targets:
  Quality / Material clear
  Supervisor / Material clear
```

### Pager device

A physical M5 pager scoped to one company and one department. It authenticates with a bearer token. The raw token is shown once during creation or rotation.

## Demo users created by seed

Run `npm run db:seed`, then use these logins:

| Username | Password | Role |
|---|---|---|
| admin | admin123 | Admin |
| manager | manager123 | Manager |
| operator | operator123 | Operator |
| quality | quality123 | Quality responder |
| supervisor | supervisor123 | Supervisor responder |
| viewer | viewer123 | Viewer |

Demo pager tokens:

| Department | Token |
|---|---|
| Quality | `demo-quality-pager-token` |
| Supervisor | `demo-supervisor-pager-token` |

## Windows Datacenter VM with PostgreSQL

These steps are for a fresh Windows Datacenter VM where the app will run from GitHub with PostgreSQL.

Open **PowerShell as Administrator**.

### 1. Install prerequisites

Install Node.js LTS, Git, and PostgreSQL:

```powershell
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements
winget install -e --id PostgreSQL.PostgreSQL.18 --accept-package-agreements --accept-source-agreements
```

Close PowerShell and open a new **Administrator** PowerShell window so PATH changes load.

Verify the tools:

```powershell
node -v
npm -v
git --version
```

Add PostgreSQL tools to this PowerShell session if `psql` is not found:

```powershell
$env:Path += ";C:\Program Files\PostgreSQL\18\bin"
psql --version
```

If PostgreSQL installed a different major version, replace `18` with that folder number.

### 2. Create the PostgreSQL database

Start `psql` as the PostgreSQL superuser. Use the postgres password you entered during PostgreSQL installation.

```powershell
$env:Path += ";C:\Program Files\PostgreSQL\18\bin"
psql -U postgres
```

Inside `psql`, run this. Change the password before using the app on a real network.

```sql
CREATE USER processguard WITH PASSWORD 'processguard_dev_password';
CREATE DATABASE processguard OWNER processguard;
GRANT ALL PRIVILEGES ON DATABASE processguard TO processguard;
\q
```

Test the new app database login:

```powershell
psql -U processguard -d processguard -h localhost
```

If it connects, run:

```sql
\q
```

### 3. Pull the app from GitHub

Create an app folder and clone the repo:

```powershell
New-Item -ItemType Directory -Force C:\Apps | Out-Null
cd C:\Apps
git clone https://github.com/jsingh-ai/Alert.git processguard-andon
cd C:\Apps\processguard-andon
```

If you previously cloned before the `Zone.Identifier` cleanup and Windows pull still fails, delete that old folder and clone fresh:

```powershell
cd C:\Apps
Remove-Item -Recurse -Force .\processguard-andon
git clone https://github.com/jsingh-ai/Alert.git processguard-andon
cd C:\Apps\processguard-andon
```

### 4. Create `.env`

Copy the example file:

```powershell
Copy-Item .env.example .env
```

Generate a JWT secret:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
```

Open `.env`:

```powershell
notepad .env
```

Use values like this:

```env
DATABASE_URL="postgresql://processguard:processguard_dev_password@localhost:5432/processguard?schema=public"
PORT=5003
HOST=0.0.0.0
JWT_SECRET="paste-the-random-secret-here"
DEMO_MODE=true
SERVE_WEB=true
CORS_ORIGIN="http://localhost:5173"
PUBLIC_URL="http://YOUR_SERVER_IP:5003"
REPORT_TIME_ZONE="America/Chicago"
SEED_DEMO=true
```

Keep `DEMO_MODE=true` for first setup so you can log in easily. After you create real users, set `DEMO_MODE=false`.

### 5. Install dependencies

```powershell
npm run install:fresh
```

### 6. Create schema and seed data

This repo currently uses Prisma schema push for setup.

```powershell
npm run db:generate
npm run db:push
npm run db:seed
```

`db:seed` creates:

- Demo users listed above.
- Press and Packaging machine groups.
- Quality and Supervisor departments.
- Call Quality, Call Supervisor, and Material Clear quick commands.
- Demo pager tokens.
- A PostgreSQL partial unique index that prevents duplicate active alerts for the same machine and department.

### 7. Build and start

```powershell
npm run build
npm run start
```

Open on the VM:

```text
http://localhost:5003
```

Open from another device on the same network:

```text
http://YOUR_SERVER_IP:5003
```

### 8. Open the Windows firewall port

Run this once in Administrator PowerShell:

```powershell
New-NetFirewallRule -DisplayName "ProcessGuard Andon 5003" -Direction Inbound -Protocol TCP -LocalPort 5003 -Action Allow
```

### 9. Install as a Windows service

For the Windows VM, the easiest production option is the included NSSM service installer. It creates a real Windows service named `ProcessGuardAndon`.

On every service start or restart it will:

- Pull latest code from GitHub.
- Install dependencies.
- Build the web and API.
- Start the API server.

It does not run database schema commands on every restart. Run those manually only when a release changes `prisma/schema.prisma`.

Install and start the service from **Administrator PowerShell**:

```powershell
cd C:\Users\jsingh\Desktop\Alert
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-service.ps1
```

Restart after pushing new code:

```powershell
Restart-Service ProcessGuardAndon
```

Useful service commands:

```powershell
Get-Service ProcessGuardAndon
Start-Service ProcessGuardAndon
Stop-Service ProcessGuardAndon
Restart-Service ProcessGuardAndon
```

Check logs:

```powershell
Get-Content .\logs\service-out.log -Tail 80
Get-Content .\logs\service-error.log -Tail 80
```

Remove the service:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\uninstall-service.ps1
```

### 10. Alternative: install as an auto-start scheduled task

After `npm run build` works, install the included scheduled task:

```powershell
cd C:\Apps\processguard-andon
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-scheduled-task.ps1
```

The task runs at startup and writes logs to:

```text
C:\Apps\processguard-andon\logs
```

Useful task commands:

```powershell
Start-ScheduledTask -TaskName ProcessGuardAndon
Stop-ScheduledTask -TaskName ProcessGuardAndon
Get-ScheduledTask -TaskName ProcessGuardAndon
```

Remove the task:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\uninstall-scheduled-task.ps1
```

### 11. Pull updates later

When you push new code and want to update the Windows VM:

If you installed the Windows service:

```powershell
cd C:\Users\jsingh\Desktop\Alert
Restart-Service ProcessGuardAndon
```

The service restart pulls, builds, and starts the newest code.

If the update includes a database schema change, run the database commands manually before restarting:

```powershell
cd C:\Users\jsingh\Desktop\Alert
Stop-Service ProcessGuardAndon
git pull origin main
npm run install:fresh
npm run db:generate
npm run db:push
Restart-Service ProcessGuardAndon
```

If you installed the scheduled task:

```powershell
cd C:\Apps\processguard-andon
Stop-ScheduledTask -TaskName ProcessGuardAndon
git pull origin main
npm run install:fresh
npm run db:generate
npm run db:push
npm run build
Start-ScheduledTask -TaskName ProcessGuardAndon
```

If you are not using the scheduled task, stop the running `npm run start` terminal, then run:

```powershell
git pull origin main
npm run install:fresh
npm run db:generate
npm run db:push
npm run build
npm run start
```

## Development mode on the server or your laptop

Use this when actively editing the app:

```powershell
npm run install:fresh
npm run db:generate
npm run db:push
npm run db:seed
npm run dev
```

Open:

```text
http://localhost:5173
```

The Vite dev server proxies `/api` and `/socket.io` to the API on port `5003`.

### Local SQLite mode without PostgreSQL

Use this when you only want to run the app locally and do not have PostgreSQL ready yet. This is a development-only path; PostgreSQL remains the default production database.

```powershell
Copy-Item .env.sqlite.example .env
npm run install:fresh
npm run setup:sqlite
npm run dev:sqlite
```

Open:

```text
http://localhost:5173
```

SQLite files live under:

```text
prisma/sqlite
```

To remove the SQLite option later, delete:

```text
prisma/sqlite
.env.sqlite.example
```

Then remove the `db:*:sqlite` and `setup:sqlite` scripts from `package.json`.

### If `npm install` hangs

The old checked-in `package-lock.json` was generated against an internal package mirror URL. On a normal Windows machine, npm may wait on those unreachable tarball URLs. This project now includes `.npmrc` pointing to the public npm registry, and the lockfile should contain only `https://registry.npmjs.org/...` resolved URLs.

`dev:sqlite`, `start:sqlite`, and the `db:*:sqlite` scripts force the SQLite environment even if your `.env` still points at PostgreSQL.

If you already have a broken partial install, remove the generated install artifacts and rerun:

```powershell
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
Remove-Item -Force package-lock.json -ErrorAction SilentlyContinue
npm run install:fresh
```

Use Node.js 22 or newer. Node 20 may install with warnings, but it is below the declared supported runtime.

## M5 pager firmware settings

Your posted firmware can keep these defaults except token/base URL:

```c
#define CONFIG_PAGER_API_BASE_URL "http://YOUR_SERVER_IP:5003"
#define CONFIG_PAGER_TOKEN "demo-quality-pager-token"
#define CONFIG_PAGER_RESPONDER_NAME "Quality"
```

Use the correct token per department:

```text
Quality: demo-quality-pager-token
Supervisor: demo-supervisor-pager-token
```

For production, generate pager tokens in:

```text
Admin Setup -> Pagers
```

Then paste the raw token into the device configuration. The raw token is only shown once.

## Pager API fields

The pager API returns these compatibility fields for the current M5 firmware:

```text
machine.name
machine.machine_code
issue_category.name
issue_problem.name
status
status_label
action_available
responder_name_text
elapsed_seconds
```

It also returns these fields for newer firmware screens:

```text
command_id
command_label
department.name
issue_text
display_message
priority
active_timer_started_at
active_timer_stage
```

`elapsed_seconds` follows the current active timer stage. For an open alert, it counts from creation. For an acknowledged alert, it counts from acknowledgement.

## Production checklist

Before using this on a real plant network:

1. Change the PostgreSQL password.
2. Set a strong `JWT_SECRET`.
3. Set `DEMO_MODE=false`.
4. Generate real pager tokens and remove demo tokens if desired.
5. Use HTTPS or keep the app on a protected local network/VPN.
6. Rotate any Wi-Fi passwords or bearer tokens that were pasted into shared code.
7. Back up PostgreSQL.
8. Run the app as a scheduled task or service account.

## Troubleshooting

### `psql` is not recognized

Add PostgreSQL to the current PowerShell session:

```powershell
$env:Path += ";C:\Program Files\PostgreSQL\18\bin"
```

### Cannot connect to database

Check `.env`:

```env
DATABASE_URL="postgresql://processguard:processguard_dev_password@localhost:5432/processguard?schema=public"
```

Then test:

```powershell
psql -U processguard -d processguard -h localhost
```

### Browser cannot reach app from another machine

Check that the app is listening on all interfaces:

```env
HOST=0.0.0.0
PORT=5003
```

Then add the firewall rule:

```powershell
New-NetFirewallRule -DisplayName "ProcessGuard Andon 5003" -Direction Inbound -Protocol TCP -LocalPort 5003 -Action Allow
```

### Pager says auth failed

Check that the device has the exact raw token from Admin Setup -> Pagers or one of the demo tokens. The app stores only token hashes, so you cannot recover old raw tokens. Rotate the pager token if needed.

### Pager is slow to show new alerts

Your firmware polls every 15 seconds when there are no active alerts. Reduce this line in firmware for faster response:

```c
#define POLL_EMPTY_MS 3000
```

For the next hardware iteration, use MQTT or long polling as a wake-up signal and keep REST as the source-of-truth snapshot.
