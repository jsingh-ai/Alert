# ProcessGuard Teams Bridge

This is a standalone companion for ProcessGuard. It does not modify or require write access to the third-party ProcessGuard repository.

## What it does

1. Polls the existing Quality, Supervisor, and Maintenance pager APIs.
2. Sends each new request to that department's Microsoft Teams Workflow.
3. Adds a passwordless **Acknowledge** link scoped to that alert and department.
4. Uses the existing ProcessGuard pager API to acknowledge the request.
5. Sends an acknowledgment card to Teams when Teams, a pager, or ProcessGuard acknowledges the request.

The link does not create a ProcessGuard login session. It expires, is cryptographically signed, and can acknowledge only its one alert. Because it does not authenticate an individual employee, ProcessGuard records the responder as `Teams — Quality`, `Teams — Supervisor`, or `Teams — Maintenance`.

The existing `TEAMS_WORKFLOW_WEBHOOK_URL` remains the default. Optional `QUALITY_TEAMS_WEBHOOK_URL`, `SUPERVISOR_TEAMS_WEBHOOK_URL`, and `MAINTENANCE_TEAMS_WEBHOOK_URL` values route departments to separate channels. Blank department URLs continue using the existing default link. Material Clear creates separate Quality and Supervisor alerts, so it reaches both destinations.

## Access needed

- **ProcessGuard admin:** create one dedicated pager/integration token for Quality and one for Supervisor. Do not reuse the physical pager token.
- **Teams:** permission to own the Workflow and post to the chosen chat/channel. The Workflows app must be allowed.
- **Windows:** permission to run Node.js and allow inbound TCP port `5010` on the plant/private network. Firewall changes may require a Windows administrator.
- **No GitHub permission is required.**

## Power Automate Workflow

Use your existing **When a Teams webhook request is received** trigger. Add or configure **Post card in a chat or channel** and use this expression as its Adaptive Card content:

```text
triggerBody()?['attachments']?[0]?['content']
```

Create one Workflow per channel when separate destinations are needed. Put each generated URL in the matching optional environment variable. If a department-specific URL is blank, the bridge continues sending that department to the existing/default Workflow.

## Configure the bridge

1. Install Node.js 22 or newer on the ProcessGuard computer.
2. In ProcessGuard Admin, create dedicated Quality, Supervisor, and Maintenance integration tokens for the departments you want the bridge to monitor.
3. Open PowerShell in this folder.
4. Run:

```powershell
.\configure.ps1
```

The script asks for the existing/default Workflow URL, optional department channel URLs, department tokens, and the ProcessGuard computer's LAN address. Secrets are stored only in the ignored local `.env` file.

## Start and test

Start the bridge:

```powershell
.\start-bridge.ps1
```

On the ProcessGuard computer, verify:

```text
http://127.0.0.1:5010/health
```

From another computer on the plant network, verify:

```text
http://10.8.10.97:5010/health
```

Create a new Quality, Supervisor, Material Clear, or Maintenance request in ProcessGuard. The first poll after a brand-new installation establishes a quiet baseline, so create the test request **after** starting the bridge. It should appear in Teams within roughly five seconds.

Click **Acknowledge Quality request** or **Acknowledge Supervisor request**, then confirm on the bridge page. ProcessGuard and the physical pager should show the request as acknowledged.

## Start automatically with Windows

After manual testing succeeds:

```powershell
.\scripts\install-startup-task.ps1
```

This installs a scheduled task for the current Windows user. Remove it with:

```powershell
.\scripts\uninstall-startup-task.ps1
```

## Network and security notes

- Port `5003` remains private. The bridge talks to ProcessGuard through `127.0.0.1`.
- Only port `5010` must be reachable by employees opening the acknowledgment link on the plant network or VPN.
- Do not expose port `5010` directly to the public internet.
- For production, put the bridge behind an internal HTTPS reverse proxy so signed links are encrypted in transit.
- Treat the Workflow URL and ProcessGuard tokens as passwords.
- Rotate any webhook or pager token previously pasted into chat or source code before production use.
- Regular Teams replies remain in Teams; this bridge synchronizes alert and acknowledgment state only.

## Useful commands

Run the automated checks:

```powershell
npm test
npm run check
```

To deliberately send currently active alerts after a fresh setup, change this in `.env` before the first start:

```text
NOTIFY_EXISTING_ALERTS_ON_START=true
```
