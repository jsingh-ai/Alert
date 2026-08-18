# ProcessGuard Teams Bridge

## 1. Create integration tokens

In ProcessGuard, open **Admin Setup** and create separate integration tokens for the Quality, Supervisor, and Maintenance departments.

## 2. Create Teams Workflows

Create a **When a Teams webhook request is received** Workflow for each Teams channel:

- Quality
- Supervisor
- Maintenance

Add each Workflow URL and its matching integration token to `teams-bridge/.env`. Start with `.env.example` if needed.

## 3. Run ProcessGuard and the bridge

From the repository root:

```powershell
npm.cmd install
npm.cmd run dev
```

This starts the API, website, and Teams bridge together. For a built production installation, run:

```powershell
npm.cmd run build
npm.cmd start
```
