# M5 Pager API Contract

The firmware can keep using the compatibility routes below.

## Authentication

Each pager sends a bearer token:

```http
Authorization: Bearer demo-quality-pager-token
```

Production tokens are generated from Admin Setup > Pagers. The raw token is shown once. The database stores a SHA-256 hash and a short fingerprint only.

## Active alerts

```http
GET /api/andon/pager/alerts/active
```

Alias:

```http
GET /api/pager/alerts/active
```

Response shape is intentionally compatible with the posted `app_main.c` parser:

```json
{
  "success": true,
  "data": [
    {
      "id": "clx_alert_id",
      "command_id": "clx_command_id",
      "command_label": "Quality Hold",
      "machine": {
        "id": "clx_machine_id",
        "name": "Press 3",
        "machine_code": "P3",
        "code": "P3"
      },
      "department": {
        "id": "clx_department_id",
        "name": "Quality"
      },
      "issue_category": {
        "id": "clx_department_id",
        "name": "Quality"
      },
      "issue_problem": {
        "id": "clx_issue_id",
        "name": "Product hold"
      },
      "issue_text": "Quality / Product hold",
      "display_message": "Seal is weak on last 20 bags",
      "status": "OPEN",
      "status_label": "Open",
      "action_available": "acknowledge",
      "responder_name_text": "",
      "responder_name": "",
      "elapsed_seconds": 14,
      "priority": "HIGH"
    }
  ]
}
```

## Actions

```http
POST /api/andon/pager/alerts/:id/acknowledge
POST /api/andon/pager/alerts/:id/arrive
POST /api/andon/pager/alerts/:id/resolve
```

Request body:

```json
{
  "responder_name_text": "Quality",
  "note": "Acknowledged on department pager"
}
```

The pager can stay simple:

- `OPEN` returns `action_available: acknowledge`
- `ACKNOWLEDGED` and `ARRIVED` return `action_available: resolve`
- resolved and cancelled alerts disappear from the active list

## Multi-department commands

One operator command creates one child alert per target department. Each department pager only sees its own child alert.

Example: `Quality Hold` creates:

- Quality alert, visible to Quality page and Quality pager
- Supervisor alert, visible to Supervisor page and Supervisor pager

Both child alerts share the same `command_id` for the manager split-screen view.
