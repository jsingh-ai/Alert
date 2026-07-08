# ProcessGuard Architecture

ProcessGuard is built around a two-level model:

```text
Operator Command
  -> Department Alert
  -> Department Alert
  -> Department Alert
```

The operator sees one call. Departments and pagers each receive their own child alert. Managers see the child alerts grouped together as a split-screen command card.

## Main web routes

```text
/login
/operator
/queue
/floor
/reports
/admin
```

## Main API routes

```text
GET  /api/session
POST /api/auth/login
POST /api/auth/demo
GET  /api/operator/bootstrap
GET  /api/operator/snapshot
POST /api/commands
GET  /api/alerts/active
POST /api/alerts/:id/acknowledge
POST /api/alerts/:id/arrive
POST /api/alerts/:id/resolve
POST /api/alerts/:id/cancel
POST /api/alerts/:id/notes
GET  /api/floor/active
GET  /api/reports/summary
GET  /api/admin/bootstrap
```

## Pager compatibility routes

```text
GET  /api/andon/pager/alerts/active
POST /api/andon/pager/alerts/:id/acknowledge
POST /api/andon/pager/alerts/:id/arrive
POST /api/andon/pager/alerts/:id/resolve
```

Aliases are also provided under `/api/pager/...`.

## Data ownership

PostgreSQL is the source of truth. Browser state is cached with TanStack Query. Socket.IO is used to notify open browser tabs to refresh after alert, command, and admin changes. The physical M5 pager remains REST polling compatible.

## Roles

```text
ADMIN      Full setup and all pages
MANAGER    Live floor, queue, operator page, reports
OPERATOR   Call Help only
RESPONDER  Department Queue and Live Floor
VIEWER     Live Floor and Queue read access
```

Scopes can restrict users to departments, machine groups, or specific machines.
