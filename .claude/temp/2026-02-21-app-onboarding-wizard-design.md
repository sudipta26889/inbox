# App Onboarding Wizard — Design Document

## Problem

The admin panel was read-only. Registering a new app required raw HTTP calls to the gateway API. There was no way for an admin to onboard a new agent application from the UI, and no developer-facing documentation was generated.

## Solution

A 5-step onboarding wizard at `/admin/onboard` that creates all required resources (tenant, app, policy, API key) and generates a ready-to-share integration guide.

## Wizard Flow

1. **Organization** (conditional) — Auto-detected. Shown only if no tenant exists.
2. **App Registration** — Name, environment, webhook URL, description.
3. **Policy Setup** — Default action, risk threshold for approval, timeout. Sensible defaults pre-filled.
4. **API Key Generation** — Auto-generated `dhara_sk_*` key, shown once with copy button.
5. **Integration Guide** — Full developer docs with Python SDK + cURL examples.

## Key Decisions

- **Progressive save**: Each step persists immediately on "Next" click.
- **Auto-detect tenant**: Skips step 1 if tenant already exists.
- **Show-once key**: API key displayed once; downloaded Markdown uses `<YOUR_API_KEY>` placeholder.
- **Persistent integration page**: Accessible anytime at `/admin/apps/<id>/integration`, not just after onboarding.
- **SDK install via Git**: `pip install "git+https://github.com/Sudiptas-AI-Agents/dharahil-sdk.git"`

## Files Changed

### Backend (gateway)
- `gateway/app/schemas/admin.py` — Added `ApiKeyGenerateRequest`, `ApiKeyGenerateOut`
- `gateway/app/routers/admin.py` — Added `POST /api-keys/generate` endpoint

### Frontend (ui)
- `ui/app/admin/onboard/page.tsx` — Wizard page (new)
- `ui/app/admin/apps/[appId]/integration/page.tsx` — Integration doc page (new)
- `ui/pages/api/admin/api-keys-generate.ts` — Proxy route (new)
- `ui/pages/api/admin/apps/[appId].ts` — Single app proxy (new)
- `ui/pages/api/admin/tenants.ts` — Added POST support
- `ui/pages/api/admin/apps.ts` — Added POST support
- `ui/pages/api/admin/api-keys.ts` — Added POST support
- `ui/pages/api/admin/policies.ts` — Added POST support
- `ui/app/admin/page.tsx` — Added "Register New App" button + "Docs" link column
