# Diseño — Integración del chat widget (@myd-org/ai-widget) en el portal Central LED

Fecha: 2026-06-12
Estado: aprobado (brainstorm)
Repo: `central-led` (CRM, Next.js 16 + React 19, App Router, iron-session).
Consume: `@myd-org/ai-widget` (subproyecto 2 del venture).

## Objetivo

Montar el chat del agente **soporte-postventa** en el portal de clientes, autenticado
con la sesión existente del CRM, hablando con `ai-api`. El cliente logueado abre un
drawer flotante y conversa; el JWT de sesión de usuario final lo mintea el backend del
CRM (la API key del tenant nunca llega al browser).

## Alcance

**En alcance:**
- Publicar `@myd-org/ai-widget@0.1.0` a GitHub Packages.
- Consumir el paquete en el CRM.
- Route de minteo de token (`/api/ai/token`) usando la sesión del CRM.
- Montar `<ChatDrawer>` (soporte-postventa) en el dashboard del portal.
- Proxy de Next a `ai-api` (sin CORS) + env.

**Fuera de alcance (dependencias separadas):**
- Que el agente lea datos REALES del cliente en Flexxus. Hoy: el CRM corre sobre
  `src/lib/mock-data.ts` (Flexxus no conectado aún) y los tools del agente apuntan al
  `fake-crm` en dev. El acceso a datos reales es el **subproyecto 1b** (API agent-facing
  de Dalila + conexión a Flexxus). Esta integración deja el chat andando contra `ai-api`
  local con la config de agente actual.
- Deploy de `ai-api` a producción (hoy solo corre local en `:3000`). El env queda
  parametrizado para apuntar a prod cuando exista.
- Tests automatizados en el CRM (verificación manual e2e por ahora).

## Contexto del CRM (existente, a reutilizar)

- **Sesión:** `iron-session` cookie `central-led-session`; `SessionData` tiene
  `isLoggedIn` y `codigocliente` (código de cliente Flexxus). Patrón en
  `src/app/api/flexxus/presupuestos/route.ts`: `getIronSession(await cookies(), sessionOptions)`,
  valida `isLoggedIn`+`codigocliente`, llama a `src/lib/flexxus.ts`.
- API routes en `src/app/api/`, portal en `src/app/portal/{page,dashboard/page}.tsx`,
  componente cliente `src/components/portal/DashboardClient.tsx` (ya `'use client'`).

## Contrato de ai-api (a consumir)

- `POST /v1/end-user-sessions` — auth: `Authorization: Bearer <API key del tenant>`.
  Body `{ external_id (req), display_name?, profile?, claims? (Record<string,string>) }`
  → `201 { token, end_user_id, expires_at }`.
- `POST /v1/conversations {agent_id}` → `{id}`; `GET /v1/conversations/:id/messages`;
  `POST /v1/conversations/:id/messages {content}` → SSE. (Lo consume el widget; ver spec
  del widget.) Todas con `Authorization: Bearer <JWT de sesión>`.

## Diseño

### 1. Publicación del widget (en el repo ai-widget)

- Sin cambios de código: en Next, el consumidor envuelve el widget en un componente
  `'use client'` (no se toca el build del widget). Publicar `0.1.0` tal cual.
- Auth de publish: `.npmrc` con `//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}` (ref a
  env, sin secreto literal) + `@myd-org:registry=https://npm.pkg.github.com`. El token de
  `gh` tiene scope `write:packages`.
- `npm publish --dry-run` para verificar el tarball (solo `dist/`), luego `npm publish`.
  `publishConfig` ya está (registry npm.pkg.github.com, access restricted).

### 2. Consumir el paquete en el CRM

- `.npmrc` en el CRM: `@myd-org:registry=https://npm.pkg.github.com` +
  `//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}`.
- `npm install @myd-org/ai-widget` (trae `markdown-to-jsx` transitivo).

### 3. Token mint route — `src/app/api/ai/token/route.ts`

```ts
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptions } from "@/lib/session"
import type { SessionData } from "@/types"

export async function POST() {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions)
  if (!session.isLoggedIn || !session.codigocliente) {
    return Response.json({ error: "No autorizado" }, { status: 401 })
  }
  const res = await fetch(`${process.env.AI_API_URL}/v1/end-user-sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.AI_API_KEY}`,
    },
    body: JSON.stringify({
      external_id: String(session.codigocliente),
      display_name: session.razonsocial ?? undefined,
      claims: { codigocliente: String(session.codigocliente) },
    }),
  })
  if (!res.ok) {
    return Response.json({ error: "No se pudo iniciar el asistente" }, { status: 502 })
  }
  const { token } = await res.json()
  return Response.json({ token })
}
```

- `display_name`: `session.razonsocial` (campo real de `SessionData`: codigocliente,
  razonsocial, cuit, email, isLoggedIn).
- `claims.codigocliente`: identifica al cliente para los tools del agente. **Las keys
  deben matchear lo que el agente soporte espera** (costura con 1b / el seed). Para dev,
  alinear con el seed; documentado, no bloquea el render del chat.

### 4. Componente de montaje — `src/components/portal/AssistantWidget.tsx`

```tsx
"use client"
import { ChatDrawer } from "@myd-org/ai-widget/preset"
import "@myd-org/ai-widget/styles"

const fetchToken = async () => {
  const r = await fetch("/api/ai/token", { method: "POST" })
  if (!r.ok) throw new Error("token")
  return (await r.json()).token as string
}

export function AssistantWidget() {
  return (
    <ChatDrawer
      config={{
        baseUrl: "/ai-api",
        agentId: process.env.NEXT_PUBLIC_AI_AGENT_ID!,
        fetchToken,
      }}
      branding={{ title: "Central LED", primaryColor: "#c4161c" }}
    />
  )
}
```

- Se monta en el dashboard del portal (en `DashboardClient.tsx`, que ya es `'use client'`,
  o en `portal/dashboard/page.tsx`). Launcher flotante, no toca el layout.
- `primaryColor`: ajustar al rojo real de Central LED.

### 5. Proxy + env

- **`next.config` rewrites:** `/ai-api/:path*` → `${AI_API_URL}/:path*`. Las llamadas del
  browser (REST + SSE) quedan same-origin → **sin CORS**, y ni la URL de ai-api ni la API
  key del tenant tocan el cliente. `baseUrl='/ai-api'`. (Next rewrites soportan streaming SSE.)
- **`.env.local`:**
  - `AI_API_URL=http://localhost:3000` — server (rewrite + token route).
  - `AI_API_KEY=<API key del tenant Central Led>` — secreto server.
  - `NEXT_PUBLIC_AI_AGENT_ID=bda5668e-339b-4921-9900-d04ff1e36fd1` — uuid del agente
    soporte en el ai-api local (público, no es secreto).
- **`.env.example`:** documentar las tres vars.
- **Puerto dev:** ai-api ocupa `:3000`; correr el CRM en `:3001` (`next dev -p 3001` o
  script). El proxy y la token route apuntan a `:3000`.

## Manejo de errores

- Sin sesión válida → `/api/ai/token` responde 401 → el widget cae en `error.code:'auth'`
  (su refresh re-intenta una vez y si falla muestra el mensaje de sesión).
- ai-api caído / 5xx en el mint → 502 → el widget muestra error genérico.
- Proxy: si `AI_API_URL` no resuelve, las llamadas del widget fallan → estado de error del
  widget. (No rompe el resto del portal: el widget está aislado.)

## Verificación (manual e2e)

1. `ai-api`: `npm run dev` en `:3000` (seed Central Led, pg en Docker).
2. CRM: `npm install`, `.env.local` cargado, `next dev -p 3001`.
3. Login al portal (código mock), abrir el drawer flotante, mandar un mensaje.
4. Esperado: el token se mintea vía `/api/ai/token` (200), la conversación streamea por
   `/ai-api/...` (proxy), el agente soporte responde. Verificar en Network que el browser
   solo habla con el origin del CRM (no con `:3000` directo) y que no se expone la API key.

## Notas de seguridad

- API key del tenant: solo en `AI_API_KEY` (server env), usada en la token route y nunca
  enviada al browser.
- Proxy oculta la URL de ai-api; el browser solo ve `/ai-api/*` y `/api/ai/token`.
- El JWT de sesión de usuario final dura ~1h; el widget lo refresca vía `fetchToken`.
