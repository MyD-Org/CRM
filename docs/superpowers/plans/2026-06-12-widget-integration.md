# Widget Integration (Central LED portal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `@myd-org/ai-widget` and mount the soporte-postventa chat (`<ChatDrawer>`) in the Central LED client portal, authenticated via the existing iron-session, talking to `ai-api` through a Next proxy.

**Architecture:** The CRM's own backend mints the end-user JWT (`/api/ai/token`, reading the iron-session, calling ai-api `/v1/end-user-sessions` with the tenant API key — key stays server-side). A `'use client'` `<AssistantWidget>` renders `<ChatDrawer>` with `baseUrl='/ai-api'`; Next `rewrites` proxy `/ai-api/*` → ai-api so the browser's REST+SSE calls are same-origin (no CORS). Agent real-data-access (Flexxus) is out of scope — the CRM runs on mock-data and the agent uses its dev config.

**Tech Stack:** Next.js 16 (App Router), React 19, iron-session, `@myd-org/ai-widget`. No test framework in the CRM → gates are `npm run lint` + `npm run build` + manual e2e.

**Spec:** `docs/superpowers/specs/2026-06-12-widget-integration-design.md`

> **Note on verification:** The CRM has no unit-test setup (scripts: dev/build/start/lint). Adding one is out of scope. Each task is gated by `npm run lint` and/or `npm run build`; the feature is verified end-to-end manually in Task 6. Code steps still show complete code.

---

## File Structure

```
ai-widget/                              # (other repo) — Task 1 only
└── .npmrc                              # CREATE (gitignored): publish auth

CRM/  (central-led)
├── .npmrc                              # CREATE: @myd-org registry + auth
├── .env.example                        # CREATE: documents AI_* envs
├── .env.local                          # CREATE (gitignored): real values for dev
├── next.config.ts                      # MODIFY: rewrites /ai-api/* → ai-api
├── package.json                        # MODIFY: dev script → port 3001
├── src/app/api/ai/token/route.ts       # CREATE: mint end-user JWT
└── src/components/portal/AssistantWidget.tsx  # CREATE: 'use client' <ChatDrawer>
    └── mounted in src/app/portal/dashboard/page.tsx  # MODIFY
```

---

## Task 1: Publish `@myd-org/ai-widget@0.1.0` to GitHub Packages

**Files (in the `ai-widget` repo, NOT the CRM):**
- Create: `~/Documents/projects/owns/ai-widget/.npmrc`

- [ ] **Step 1: Ensure `.npmrc` is gitignored, then create it**

```bash
cd ~/Documents/projects/owns/ai-widget
grep -qxF '.npmrc' .gitignore || echo '.npmrc' >> .gitignore
cat > .npmrc <<'EOF'
@myd-org:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
EOF
```

- [ ] **Step 2: Confirm the build is current and inspect the publish tarball (dry run)**

```bash
cd ~/Documents/projects/owns/ai-widget
npm run build
GITHUB_TOKEN=$(gh auth token) npm publish --dry-run
```
Expected: dry-run lists the tarball contents = only `dist/**` (index.js/cjs/d.ts, preset/*, aichat.css) + package.json + README. No `src/`, no `example/`. No errors.

- [ ] **Step 3: Publish**

```bash
cd ~/Documents/projects/owns/ai-widget
GITHUB_TOKEN=$(gh auth token) npm publish
```
Expected: `+ @myd-org/ai-widget@0.1.0`. (If it fails with 403/scope, the gh token lacks `write:packages` — run `gh auth refresh -h github.com -s write:packages` and retry.)

- [ ] **Step 4: Verify the package is visible**

```bash
GITHUB_TOKEN=$(gh auth token) npm view @myd-org/ai-widget version --registry=https://npm.pkg.github.com
```
Expected: prints `0.1.0`.

No commit needed (the `.npmrc` is gitignored; nothing else changed in ai-widget).

---

## Task 2: CRM — configure the registry and install the widget

**Files:**
- Create: `~/Documents/projects/owns/CRM/.npmrc`
- Modify: `~/Documents/projects/owns/CRM/package.json` (adds the dependency)

- [ ] **Step 1: Create `.npmrc` in the CRM**

```bash
cd ~/Documents/projects/owns/CRM
cat > .npmrc <<'EOF'
@myd-org:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
EOF
```
(Safe to commit: the token is an env-var reference, not a literal.)

- [ ] **Step 2: Install the widget**

```bash
cd ~/Documents/projects/owns/CRM
GITHUB_TOKEN=$(gh auth token) npm install @myd-org/ai-widget
```
Expected: adds `@myd-org/ai-widget` to `dependencies` (and `markdown-to-jsx` transitively).

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/projects/owns/CRM
git add .npmrc package.json package-lock.json
git commit -m "chore: configure GitHub Packages registry + install @myd-org/ai-widget"
```

---

## Task 3: CRM — token mint route

**Files:**
- Create: `~/Documents/projects/owns/CRM/src/app/api/ai/token/route.ts`

- [ ] **Step 1: Write the route**

```ts
// src/app/api/ai/token/route.ts
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptions } from "@/lib/session"
import type { SessionData } from "@/types"

// Mintea el JWT de sesión de usuario final para el widget. La API key del tenant
// vive solo en el server (AI_API_KEY); el browser nunca la ve.
export async function POST() {
  const cookieStore = await cookies()
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions)

  if (!session.isLoggedIn || !session.codigocliente) {
    return Response.json({ error: "No autorizado" }, { status: 401 })
  }

  const apiUrl = process.env.AI_API_URL
  const apiKey = process.env.AI_API_KEY
  if (!apiUrl || !apiKey) {
    console.error("ai/token: faltan AI_API_URL o AI_API_KEY")
    return Response.json({ error: "Asistente no configurado" }, { status: 500 })
  }

  try {
    const res = await fetch(`${apiUrl}/v1/end-user-sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        external_id: String(session.codigocliente),
        display_name: session.razonsocial ?? undefined,
        claims: { codigocliente: String(session.codigocliente) },
      }),
    })
    if (!res.ok) {
      console.error("ai/token: end-user-sessions respondió", res.status)
      return Response.json({ error: "No se pudo iniciar el asistente" }, { status: 502 })
    }
    const data = (await res.json()) as { token: string }
    return Response.json({ token: data.token })
  } catch (err) {
    console.error("ai/token error:", err)
    return Response.json({ error: "No se pudo iniciar el asistente" }, { status: 502 })
  }
}
```

- [ ] **Step 2: Lint the new file**

```bash
cd ~/Documents/projects/owns/CRM
npm run lint
```
Expected: no errors for `src/app/api/ai/token/route.ts`.

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/projects/owns/CRM
git add src/app/api/ai/token/route.ts
git commit -m "feat: ruta /api/ai/token que mintea la sesión del asistente"
```

---

## Task 4: CRM — `<AssistantWidget>` component

**Files:**
- Create: `~/Documents/projects/owns/CRM/src/components/portal/AssistantWidget.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/portal/AssistantWidget.tsx
"use client"

import { ChatDrawer } from "@myd-org/ai-widget/preset"
import "@myd-org/ai-widget/styles"

async function fetchToken(): Promise<string> {
  const r = await fetch("/api/ai/token", { method: "POST" })
  if (!r.ok) throw new Error(`token ${r.status}`)
  const { token } = (await r.json()) as { token: string }
  return token
}

export function AssistantWidget() {
  const agentId = process.env.NEXT_PUBLIC_AI_AGENT_ID
  if (!agentId) return null
  return (
    <ChatDrawer
      config={{ baseUrl: "/ai-api", agentId, fetchToken }}
      branding={{ title: "Central LED", primaryColor: "#c4161c" }}
    />
  )
}
```

- [ ] **Step 2: Lint**

```bash
cd ~/Documents/projects/owns/CRM
npm run lint
```
Expected: no errors for the new file.

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/projects/owns/CRM
git add src/components/portal/AssistantWidget.tsx
git commit -m "feat: AssistantWidget (ChatDrawer soporte) para el portal"
```

---

## Task 5: CRM — proxy, env, dev port, and mount

**Files:**
- Modify: `~/Documents/projects/owns/CRM/next.config.ts`
- Modify: `~/Documents/projects/owns/CRM/package.json`
- Create: `~/Documents/projects/owns/CRM/.env.example`
- Modify: `~/Documents/projects/owns/CRM/src/app/portal/dashboard/page.tsx`

- [ ] **Step 1: Add the proxy rewrite to `next.config.ts`**

Replace the whole file with:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    const aiApiUrl = process.env.AI_API_URL ?? "http://localhost:3000";
    return [
      // El browser habla same-origin con /ai-api/* ; Next lo proxea a ai-api (sin CORS).
      { source: "/ai-api/:path*", destination: `${aiApiUrl}/:path*` },
    ];
  },
};

export default nextConfig;
```

- [ ] **Step 2: Move the CRM dev server off port 3000 (ai-api owns it)**

In `package.json`, change the `dev` script:

```json
  "scripts": {
    "dev": "next dev -p 3001",
    "build": "next build",
    "start": "next start",
    "lint": "eslint"
  }
```

- [ ] **Step 3: Create `.env.example`**

```bash
cd ~/Documents/projects/owns/CRM
cat > .env.example <<'EOF'
# URL de ai-api (server: usado por el proxy de next.config y por /api/ai/token)
AI_API_URL=http://localhost:3000
# API key del tenant Central LED en ai-api (SECRETO — solo server)
AI_API_KEY=
# UUID del agente soporte-postventa en ai-api (público; no es secreto)
NEXT_PUBLIC_AI_AGENT_ID=bda5668e-339b-4921-9900-d04ff1e36fd1
EOF
```

- [ ] **Step 4: Create `.env.local` for dev (gitignored by Next's default .gitignore)**

```bash
cd ~/Documents/projects/owns/CRM
cat > .env.local <<'EOF'
AI_API_URL=http://localhost:3000
AI_API_KEY=PEGAR_API_KEY_DEL_TENANT_CENTRAL_LED
NEXT_PUBLIC_AI_AGENT_ID=bda5668e-339b-4921-9900-d04ff1e36fd1
EOF
echo ".env.local creado — pegar la API key real del tenant antes de verificar"
grep -qE '^\.env' .gitignore && echo ".env* ya ignorado" || echo "REVISAR .gitignore"
```

- [ ] **Step 5: Mount `<AssistantWidget/>` in the dashboard page**

Replace the contents of `src/app/portal/dashboard/page.tsx` with:

```tsx
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { redirect } from "next/navigation"
import { sessionOptions } from "@/lib/session"
import { mockCliente, mockFacturas, mockPagos, mockPresupuestos } from "@/lib/mock-data"
import { DashboardClient } from "@/components/portal/DashboardClient"
import { AssistantWidget } from "@/components/portal/AssistantWidget"
import type { SessionData } from "@/types"

export default async function DashboardPage() {
  const cookieStore = await cookies()
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions)

  if (!session.isLoggedIn) {
    redirect("/portal")
  }

  return (
    <>
      <DashboardClient
        cliente={mockCliente}
        facturas={mockFacturas}
        pagos={mockPagos}
        presupuestos={mockPresupuestos}
        razonsocial={session.razonsocial ?? mockCliente.razonsocial}
      />
      <AssistantWidget />
    </>
  )
}
```

- [ ] **Step 6: Build to verify the app compiles with the widget + config**

```bash
cd ~/Documents/projects/owns/CRM
GITHUB_TOKEN=$(gh auth token) npm run build
```
Expected: build succeeds. (If it complains about importing the widget in a client boundary, confirm `AssistantWidget.tsx` starts with `"use client"`.)

- [ ] **Step 7: Commit**

```bash
cd ~/Documents/projects/owns/CRM
git add next.config.ts package.json .env.example src/app/portal/dashboard/page.tsx
git commit -m "feat: proxy a ai-api + montar AssistantWidget en el dashboard del portal"
```

---

## Task 6: Manual end-to-end verification

**No files.** Confirms the integrated flow works.

- [ ] **Step 1: Start ai-api**

```bash
cd ~/Documents/projects/owns/ai-api
docker ps --filter name=ai-api-pg --format '{{.Names}}'   # debe existir; si no: levantar el contenedor
npm run dev    # :3000, seed Central Led, API key real en .env
```
Expected: `curl -sf http://localhost:3000/demo/agents` lists `soporte-postventa` with id `bda5668e-...`. Put that tenant's API key into the CRM `.env.local` `AI_API_KEY` (obtenerla del seed/DB de ai-api).

- [ ] **Step 2: Start the CRM**

```bash
cd ~/Documents/projects/owns/CRM
GITHUB_TOKEN=$(gh auth token) npm install   # si no se instaló aún
npm run dev    # :3001
```

- [ ] **Step 3: Drive the portal**

Open `http://localhost:3001/portal`, log in (código mock del flujo de auth), llegar al dashboard. Click the floating chat launcher (bottom-right) and send a message.

Expected:
- Network: `POST /api/ai/token` → 200 `{token}`.
- Network: `POST /ai-api/v1/conversations` → 201; `POST /ai-api/v1/conversations/:id/messages` → streaming SSE.
- The drawer shows the assistant streaming a reply. The browser talks ONLY to `localhost:3001` (proxy), never `:3000` directly, and `AI_API_KEY` never appears in any browser request.

- [ ] **Step 4: Record the result**

If it works: note success. If a step fails, capture the failing request/response and stop to debug (do not mark complete).

---

## Self-Review

**Spec coverage:**
- Publicar widget 0.1.0 a GitHub Packages → Task 1. ✓
- Consumir el paquete (.npmrc + install) → Task 2. ✓
- Token mint route con iron-session → ai-api `/v1/end-user-sessions` (key server-side) → Task 3. ✓
- `<AssistantWidget>` `'use client'` con `<ChatDrawer>` soporte, fetchToken, styles → Task 4. ✓
- Proxy Next (`/ai-api/*`), env (AI_API_URL/AI_API_KEY/NEXT_PUBLIC_AI_AGENT_ID), dev port 3001, montaje en dashboard → Task 5. ✓
- Verificación manual e2e (token 200, SSE por proxy, key no expuesta) → Task 6. ✓
- Fuera de alcance (datos reales Flexxus/1b, deploy, tests) → respetado; ninguna tarea los incluye. ✓

**Placeholder scan:** Sin TBD/TODO. El único valor a completar a mano es `AI_API_KEY` en `.env.local` (secreto que no va al repo) — está marcado explícitamente como acción del operador en Task 5/6, no es un placeholder de código. ✓

**Type consistency:** `SessionData` usa `codigocliente`/`razonsocial` (verificado en src/types). `fetchToken` devuelve `string`; `/api/ai/token` devuelve `{token}` consumido por `AssistantWidget`. `baseUrl='/ai-api'` matchea el rewrite `source:'/ai-api/:path*'`. `NEXT_PUBLIC_AI_AGENT_ID` usado en Task 4 y definido en Task 5. ✓
