# Portal Client Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Login real de clientes del portal: contraseña provisoria generada por el operador, setup en primer ingreso (contraseña + email), login por CUIT/email/Google, recuperación por email. Reemplaza el OTP inusable.

**Architecture:** Tabla `portal_users` en la DB propia ancla `codigocliente` (contacto de Alegra) ↔ credenciales. Sesión sigue siendo `iron-session` (cookie sellada). Google OAuth manual (authorization code + verificación de `id_token`), con callback de doble modo (`login`|`link`) discriminado por `state`. Hashing scrypt reusando `src/lib/admin-crypto.ts`.

**Tech Stack:** Next.js 16 App Router, drizzle-orm + postgres.js (Neon en prod), iron-session, `google-auth-library` (nueva dep), Resend, vitest.

**Spec:** `docs/superpowers/specs/2026-07-13-portal-client-auth-design.md`

---

## Prerrequisitos manuales (el usuario, no el agente)

1. Crear OAuth Client en Google Cloud Console (tipo "Web application"):
   - Authorized redirect URIs: `http://localhost:3000/api/auth/google/callback` (dev) y `https://crm-sage-pi.vercel.app/api/auth/google/callback` (prod).
2. Cargar en `.env.local` (dev) y en Vercel (prod): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.
3. Al deployar: correr la migración contra Neon (`DATABASE_URL` de prod) — **pedir confirmación del usuario antes**.

## Mapa de archivos

| Acción | Archivo | Responsabilidad |
|---|---|---|
| Commit | `scripts/alegra-smoke.ts` | (pendiente de sesión anterior) smoke read-only extendido |
| Create | `src/lib/portal-auth.ts` | helpers puros: normalizar CUIT, clasificar identificador, provisoria, constantes |
| Create | `src/lib/portal-auth.test.ts` | unit tests de los helpers |
| Modify | `src/db/schema.ts` | tablas `portal_users`, `portal_password_tokens` |
| Modify | `src/types/index.ts` | `SessionData` + `pendingSetup`/`portalUserId` |
| Modify | `src/lib/session.ts` | `oauthStateSessionOptions` (cookie corta para `state`) |
| Create | `src/lib/google-oauth.ts` | wrapper OAuth: auth URL + verificación de code/id_token |
| Create | `src/app/api/admin/portal-users/route.ts` | POST generar/regenerar acceso |
| Create | `src/app/admin/(protected)/clientes/page.tsx` | página admin Clientes (server) |
| Create | `src/components/admin/ClientAccessList.tsx` | lista + búsqueda + botón "Generar acceso" (client) |
| Modify | `src/components/admin/AdminShell.tsx` | ítem "Clientes" en NAV |
| Create | `src/app/api/auth/login/route.ts` | login con contraseña |
| Create | `src/app/api/auth/setup/route.ts` | setup primer ingreso |
| Create | `src/app/portal/setup/page.tsx` + `src/components/portal/SetupForm.tsx` | pantalla de setup |
| Create | `src/app/api/auth/google/start/route.ts` | inicio OAuth (login\|link) |
| Create | `src/app/api/auth/google/callback/route.ts` | callback doble modo |
| Create | `src/app/api/auth/forgot/route.ts` | pedir reset por email |
| Create | `src/app/api/auth/reset/route.ts` | consumir token de reset |
| Create | `src/app/portal/reset/[token]/page.tsx` + `src/components/portal/ResetForm.tsx` | pantalla de reset |
| Modify | `src/components/portal/LoginPage.tsx` | form contraseña + botón Google (reemplaza OTP) |
| Delete | `src/app/api/auth/send-code/route.ts`, `src/app/api/auth/verify-code/route.ts` | OTP muerto |

---

### Task 0: Commit pendiente del smoke test de Alegra

**Files:**
- Commit: `scripts/alegra-smoke.ts` (ya modificado en working tree)

- [ ] **Step 1: Verificar que el smoke sigue pasando**

Run: `npm run alegra:smoke -- --tenant central-led`
Expected: secciones de listas/terms/sellers/taxes/currencies/items/contacts OK y termina con "OK — solo lecturas".

- [ ] **Step 2: Commit**

```bash
git add scripts/alegra-smoke.ts
git commit -m "feat(smoke): sección de cuenta corriente en alegra-smoke (invoices/payments/balance/estimates, --contact-id)"
```

---

### Task 1: Helpers puros de auth (`portal-auth.ts`) — TDD

**Files:**
- Create: `src/lib/portal-auth.ts`
- Test: `src/lib/portal-auth.test.ts`

- [ ] **Step 1: Escribir tests que fallan**

```ts
// src/lib/portal-auth.test.ts
import { describe, expect, it } from "vitest"
import { classifyIdentifier, generateProvisionalPassword, normalizeCuit } from "./portal-auth"

describe("normalizeCuit", () => {
  it("quita guiones y espacios", () => {
    expect(normalizeCuit("30-57254481-4")).toBe("30572544814")
    expect(normalizeCuit(" 30 57254481 4 ")).toBe("30572544814")
  })
  it("deja solo dígitos", () => {
    expect(normalizeCuit("CUIT: 30.57254481.4")).toBe("30572544814")
  })
})

describe("classifyIdentifier", () => {
  it("detecta email y lo baja a minúsculas", () => {
    expect(classifyIdentifier(" Juan@Empresa.COM ")).toEqual({ kind: "email", value: "juan@empresa.com" })
  })
  it("sin @ es CUIT normalizado", () => {
    expect(classifyIdentifier("30-57254481-4")).toEqual({ kind: "cuit", value: "30572544814" })
  })
})

describe("generateProvisionalPassword", () => {
  it("largo 12 por defecto y solo chars del alfabeto sin ambiguos", () => {
    const p = generateProvisionalPassword()
    expect(p).toHaveLength(12)
    expect(p).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789]+$/)
  })
  it("no repite entre llamadas", () => {
    expect(generateProvisionalPassword()).not.toBe(generateProvisionalPassword())
  })
})
```

- [ ] **Step 2: Correr y ver que falla**

Run: `npx vitest run src/lib/portal-auth.test.ts`
Expected: FAIL — "Cannot find module './portal-auth'".

- [ ] **Step 3: Implementación mínima**

```ts
// src/lib/portal-auth.ts
import { randomBytes } from "node:crypto"

// Helpers puros del login de clientes del portal. Sin DB ni Next runtime (unit-testeables).
// Ver spec: docs/superpowers/specs/2026-07-13-portal-client-auth-design.md

/** CUIT normalizado a solo dígitos ("30-57254481-4" → "30572544814"). Se aplica en alta y login. */
export function normalizeCuit(raw: string): string {
  return raw.replace(/\D/g, "")
}

/** Identificador de login: email si contiene "@", si no CUIT normalizado. */
export function classifyIdentifier(raw: string): { kind: "email" | "cuit"; value: string } {
  const trimmed = raw.trim()
  if (trimmed.includes("@")) return { kind: "email", value: trimmed.toLowerCase() }
  return { kind: "cuit", value: normalizeCuit(trimmed) }
}

// Sin 0/O/1/l/I para que la provisoria se pueda dictar por teléfono sin ambigüedad.
const PROVISIONAL_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"

/** Contraseña provisoria aleatoria (crypto), legible, 12 chars. */
export function generateProvisionalPassword(length = 12): string {
  const bytes = randomBytes(length)
  let out = ""
  for (let i = 0; i < length; i++) out += PROVISIONAL_ALPHABET[bytes[i] % PROVISIONAL_ALPHABET.length]
  return out
}

export const PROVISIONAL_TTL_MS = 7 * 24 * 60 * 60 * 1000 // provisoria vence a los 7 días
export const MAX_FAILED_ATTEMPTS = 5 // espejo del MAX_OTP_ATTEMPTS que reemplazamos
export const LOCKOUT_MS = 15 * 60 * 1000 // lockout temporal en DB (sirve en serverless)
export const RESET_COOLDOWN_MS = 5 * 60 * 1000 // máx. 1 token de reset cada 5 min
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000 // el link de reset vence en 1 hora (igual que admin)
export const MIN_PASSWORD_LENGTH = 8 // igual que admin reset-password
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `npx vitest run src/lib/portal-auth.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/portal-auth.ts src/lib/portal-auth.test.ts
git commit -m "feat(auth): helpers puros del login de clientes (CUIT, identificador, provisoria)"
```

---

### Task 2: Schema — `portal_users` y `portal_password_tokens`

**Files:**
- Modify: `src/db/schema.ts` (agregar al final; imports ya incluyen `boolean`, `integer`, `uniqueIndex`)

- [ ] **Step 1: Agregar `sql` a los imports**

En `src/db/schema.ts`, arriba de los imports de `drizzle-orm/pg-core`, agregar:

```ts
import { sql } from "drizzle-orm"
```

- [ ] **Step 2: Agregar las tablas al final del archivo**

```ts
// Usuarios del portal de clientes. El vínculo con Alegra es codigocliente (id de contacto).
// Credenciales propias: Alegra no guarda nada de esto. Ver spec 2026-07-13-portal-client-auth.
export const portalUsers = pgTable(
  "portal_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    codigocliente: text("codigocliente").notNull(), // id de contacto de Alegra
    cuit: text("cuit").notNull(), // normalizado a solo dígitos (normalizeCuit)
    email: text("email"), // null hasta el setup; ahí es obligatorio
    // scrypt (admin-crypto). Siempre presente: provisoria o definitiva. Google es un extra.
    passwordHash: text("password_hash").notNull(),
    googleId: text("google_id"), // `sub` de Google; null si no vinculó
    mustChangePassword: boolean("must_change_password").notNull().default(true),
    provisionalExpiresAt: timestamp("provisional_expires_at", { withTimezone: true }),
    status: text("status").notNull().default("active"), // active | disabled
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }), // lockout temporal (15 min)
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pu_tenant_codigocliente").on(t.tenantId, t.codigocliente),
    uniqueIndex("pu_tenant_cuit").on(t.tenantId, t.cuit),
    uniqueIndex("pu_tenant_email").on(t.tenantId, t.email).where(sql`${t.email} is not null`),
    uniqueIndex("pu_tenant_google").on(t.tenantId, t.googleId).where(sql`${t.googleId} is not null`),
  ],
)

// Tokens de reset de contraseña del portal — espejo de admin_password_tokens.
export const portalPasswordTokens = pgTable(
  "portal_password_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    portalUserId: uuid("portal_user_id")
      .notNull()
      .references(() => portalUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ppt_token_hash").on(t.tokenHash)],
)
```

- [ ] **Step 3: Generar y aplicar la migración local**

Run: `npm run db:generate` → genera `drizzle/000N_*.sql` con ambas tablas.
Run: `npm run db:migrate` → aplica contra la DB local (`postgres://dalilacabeza@localhost:5432/crm`).
Expected: sin errores; verificar con `psql -h localhost -d crm -c '\d portal_users'` que existen las columnas e índices.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(db): tablas portal_users y portal_password_tokens"
```

---

### Task 3: Sesión — `SessionData` extendida + cookie de estado OAuth

**Files:**
- Modify: `src/types/index.ts:70-77`
- Modify: `src/lib/session.ts`

- [ ] **Step 1: Extender `SessionData`**

En `src/types/index.ts`, reemplazar la interfaz `SessionData` por:

```ts
export interface SessionData {
  codigocliente?: string
  razonsocial?: string
  cuit?: string
  email?: string
  tipoCuenta?: "corriente" | "contado"
  isLoggedIn: boolean
  // Primer ingreso: autenticado con provisoria pero sin completar el setup.
  // pendingSetup=true habilita SOLO /portal/setup y los endpoints de setup/link.
  pendingSetup?: boolean
  portalUserId?: string
}
```

(No tocar `OtpSessionData` todavía — se borra en Task 10.)

- [ ] **Step 2: Agregar la cookie corta para el `state` de OAuth**

En `src/lib/session.ts`, agregar al final:

```ts
// Estado CSRF del round-trip OAuth con Google (login|link). Cookie corta, se descarta al volver.
export interface OAuthStateSession {
  state?: string
  mode?: "login" | "link"
}

export const oauthStateSessionOptions: SessionOptions = {
  password: SESSION_SECRET,
  cookieName: "portal-oauth",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 10,
  },
}
```

- [ ] **Step 3: Verificar que compila**

Run: `npx tsc --noEmit`
Expected: sin errores nuevos.

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts src/lib/session.ts
git commit -m "feat(auth): SessionData con pendingSetup + cookie de estado OAuth"
```

---

### Task 4: API admin — generar/regenerar acceso

**Files:**
- Create: `src/app/api/admin/portal-users/route.ts`

- [ ] **Step 1: Implementar el endpoint**

```ts
// src/app/api/admin/portal-users/route.ts
import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { and, eq } from "drizzle-orm"
import { getDb } from "@/db"
import { portalUsers } from "@/db/schema"
import { hashPassword } from "@/lib/admin-crypto"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { getTenantByIdFromDb } from "@/lib/tenants"
import { getContact } from "@/lib/alegra"
import { generateProvisionalPassword, normalizeCuit, PROVISIONAL_TTL_MS } from "@/lib/portal-auth"

// POST { codigocliente } → genera (o regenera) la contraseña provisoria del cliente.
// Regenerar resetea hash, vencimiento, must_change y lockout — sirve para provisoria
// vencida y para destrabar una cuenta bloqueada. La provisoria se devuelve UNA sola vez.
export async function POST(req: NextRequest) {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "No autorizado" }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body?.codigocliente) return NextResponse.json({ error: "codigocliente requerido" }, { status: 400 })

  const tenant = await getTenantByIdFromDb(session.tenantId)
  if (!tenant) return NextResponse.json({ error: "Tenant no encontrado" }, { status: 500 })

  const contact = await getContact(tenant, String(body.codigocliente))
  if (!contact) return NextResponse.json({ error: "Contacto no encontrado en Alegra" }, { status: 404 })

  const cuit = normalizeCuit(contact.identification ?? "")
  if (!cuit) return NextResponse.json({ error: "El contacto no tiene CUIT/identificación en Alegra" }, { status: 422 })

  const provisional = generateProvisionalPassword()
  const passwordHash = await hashPassword(provisional)
  const provisionalExpiresAt = new Date(Date.now() + PROVISIONAL_TTL_MS)

  await getDb()
    .insert(portalUsers)
    .values({
      tenantId: session.tenantId,
      codigocliente: contact.alegraId,
      cuit,
      passwordHash,
      mustChangePassword: true,
      provisionalExpiresAt,
    })
    .onConflictDoUpdate({
      target: [portalUsers.tenantId, portalUsers.codigocliente],
      set: {
        passwordHash,
        cuit,
        mustChangePassword: true,
        provisionalExpiresAt,
        failedAttempts: 0,
        lockedUntil: null,
        status: "active",
        updatedAt: new Date(),
      },
    })

  return NextResponse.json({
    provisionalPassword: provisional,
    cuit,
    name: contact.name,
    expiresAt: provisionalExpiresAt.toISOString(),
  })
}

// GET → estado de acceso de los clientes del tenant (para pintar la lista en el admin).
export async function GET() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "No autorizado" }, { status: 401 })

  const rows = await getDb()
    .select({
      codigocliente: portalUsers.codigocliente,
      email: portalUsers.email,
      mustChangePassword: portalUsers.mustChangePassword,
      provisionalExpiresAt: portalUsers.provisionalExpiresAt,
      lockedUntil: portalUsers.lockedUntil,
      lastLoginAt: portalUsers.lastLoginAt,
      status: portalUsers.status,
      googleId: portalUsers.googleId,
    })
    .from(portalUsers)
    .where(and(eq(portalUsers.tenantId, session.tenantId), eq(portalUsers.status, "active")))

  return NextResponse.json(rows.map((r) => ({ ...r, hasGoogle: !!r.googleId, googleId: undefined })))
}
```

- [ ] **Step 2: Verificar compilación**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 3: Probar a mano (dev server corriendo, logueado en /admin)**

Run: con el navegador logueado en `/admin`, desde la consola: `fetch("/api/admin/portal-users", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({codigocliente:"1"})}).then(r=>r.json()).then(console.log)`
Expected: `{ provisionalPassword: "…12 chars…", cuit: "30572544814", name: "ACERTUBO…", expiresAt: "…" }`. Segunda llamada: regenera (nueva provisoria).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/admin/portal-users/route.ts
git commit -m "feat(admin): endpoint generar/regenerar acceso de clientes al portal"
```

---

### Task 5: Página admin "Clientes"

**Files:**
- Create: `src/app/admin/(protected)/clientes/page.tsx`
- Create: `src/components/admin/ClientAccessList.tsx`
- Modify: `src/components/admin/AdminShell.tsx:24-28` (NAV)

- [ ] **Step 1: Server page**

```tsx
// src/app/admin/(protected)/clientes/page.tsx
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { getTenantByIdFromDb } from "@/lib/tenants"
import { getClientes } from "@/lib/erp"
import { ClientAccessList } from "@/components/admin/ClientAccessList"

export const dynamic = "force-dynamic"

export default async function ClientesPage() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  const tenant = session.tenantId ? await getTenantByIdFromDb(session.tenantId) : null

  // Lista completa de contactos de Alegra (pagina hasta agotar; aceptable v1).
  const clientes = tenant ? await getClientes(tenant) : []

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold text-text">Clientes</h1>
      <p className="text-sm text-subtle mb-4">Acceso de clientes al portal</p>
      <ClientAccessList clientes={clientes.map((c) => ({ codigocliente: c.codigocliente, razonsocial: c.razonsocial, cuit: c.cuit }))} />
    </div>
  )
}
```

- [ ] **Step 2: Client component (búsqueda + generar acceso + provisoria una sola vez)**

```tsx
// src/components/admin/ClientAccessList.tsx
"use client"

import { useEffect, useMemo, useState } from "react"

interface ClienteRow {
  codigocliente: string
  razonsocial: string
  cuit: string
}

interface AccessRow {
  codigocliente: string
  email: string | null
  mustChangePassword: boolean
  provisionalExpiresAt: string | null
  lockedUntil: string | null
  lastLoginAt: string | null
  hasGoogle: boolean
}

function accessLabel(a: AccessRow | undefined): string {
  if (!a) return "Sin acceso"
  if (a.lockedUntil && new Date(a.lockedUntil) > new Date()) return "Bloqueado"
  if (a.mustChangePassword) {
    const expired = a.provisionalExpiresAt && new Date(a.provisionalExpiresAt) < new Date()
    return expired ? "Provisoria vencida" : "Provisoria vigente"
  }
  return a.hasGoogle ? "Activo (Google)" : "Activo"
}

export function ClientAccessList({ clientes }: { clientes: ClienteRow[] }) {
  const [query, setQuery] = useState("")
  const [access, setAccess] = useState<Map<string, AccessRow>>(new Map())
  const [busy, setBusy] = useState<string | null>(null)
  const [provisional, setProvisional] = useState<{ name: string; password: string; expiresAt: string } | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    fetch("/api/admin/portal-users")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: AccessRow[]) => setAccess(new Map(rows.map((r) => [r.codigocliente, r]))))
      .catch(() => {})
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return clientes.slice(0, 50)
    const qDigits = q.replace(/\D/g, "")
    return clientes
      .filter((c) => c.razonsocial.toLowerCase().includes(q) || (qDigits && c.cuit.replace(/\D/g, "").includes(qDigits)))
      .slice(0, 50)
  }, [clientes, query])

  async function generar(c: ClienteRow) {
    setBusy(c.codigocliente)
    setError("")
    try {
      const res = await fetch("/api/admin/portal-users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codigocliente: c.codigocliente }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Error al generar el acceso")
        return
      }
      setProvisional({ name: c.razonsocial, password: data.provisionalPassword, expiresAt: data.expiresAt })
      const rows: AccessRow[] = await fetch("/api/admin/portal-users").then((r) => r.json())
      setAccess(new Map(rows.map((r) => [r.codigocliente, r])))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <input
        className="w-full max-w-md rounded-lg border border-line bg-surface px-3 py-2 text-sm mb-4"
        placeholder="Buscar por razón social o CUIT…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}

      {provisional && (
        <div className="mb-4 rounded-lg border border-line bg-surface p-4">
          <p className="text-sm font-medium text-text">Contraseña provisoria de {provisional.name}</p>
          <p className="my-2 font-mono text-lg tracking-wider select-all">{provisional.password}</p>
          <p className="text-xs text-subtle">
            Copiala ahora — no se vuelve a mostrar. Vence el {new Date(provisional.expiresAt).toLocaleDateString("es-AR")}.
          </p>
          <button className="mt-2 text-sm underline" onClick={() => setProvisional(null)}>
            Cerrar
          </button>
        </div>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-subtle border-b border-line">
            <th className="py-2">Razón social</th>
            <th>CUIT</th>
            <th>Acceso</th>
            <th>Email</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((c) => {
            const a = access.get(c.codigocliente)
            return (
              <tr key={c.codigocliente} className="border-b border-line/50">
                <td className="py-2">{c.razonsocial}</td>
                <td>{c.cuit}</td>
                <td>{accessLabel(a)}</td>
                <td>{a?.email ?? "—"}</td>
                <td className="text-right">
                  <button
                    className="rounded-md border border-line px-3 py-1 text-xs hover:bg-surface disabled:opacity-50"
                    disabled={busy === c.codigocliente}
                    onClick={() => generar(c)}
                  >
                    {busy === c.codigocliente ? "Generando…" : a ? "Regenerar acceso" : "Generar acceso"}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {filtered.length === 0 && <p className="text-sm text-subtle py-4">Sin resultados.</p>}
    </div>
  )
}
```

- [ ] **Step 3: Ítem en la NAV**

En `src/components/admin/AdminShell.tsx`: agregar `Contact` al import de lucide-react y el ítem en `NAV` (visible para operadores y superadmin — el alta la hace cualquier operador):

```ts
import { MessageSquare, Users, LogOut, Package, Contact } from "lucide-react"

const NAV = [
  { href: "/admin/inbox", label: "Inbox", icon: <MessageSquare size={16} strokeWidth={1.6} /> },
  { href: "/admin/clientes", label: "Clientes", icon: <Contact size={16} strokeWidth={1.6} /> },
  { href: "/admin/catalogo", label: "Catálogo", icon: <Package size={16} strokeWidth={1.6} />, superadminOnly: true },
  { href: "/admin/usuarios", label: "Usuarios", icon: <Users size={16} strokeWidth={1.6} />, superadminOnly: true },
]
```

- [ ] **Step 4: Verificar en el navegador**

Run: `npm run dev`, ir a `http://localhost:3000/admin/clientes` (logueado).
Expected: lista de clientes de Alegra (o del mock), búsqueda filtra, "Generar acceso" muestra la provisoria una vez y el estado pasa a "Provisoria vigente".

- [ ] **Step 5: Commit**

```bash
git add "src/app/admin/(protected)/clientes/page.tsx" src/components/admin/ClientAccessList.tsx src/components/admin/AdminShell.tsx
git commit -m "feat(admin): página Clientes con generación de acceso al portal"
```

---

### Task 6: API de login con contraseña

**Files:**
- Create: `src/app/api/auth/login/route.ts`

- [ ] **Step 1: Implementar**

```ts
// src/app/api/auth/login/route.ts
import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { and, eq } from "drizzle-orm"
import { getDb } from "@/db"
import { portalUsers } from "@/db/schema"
import { verifyPassword } from "@/lib/admin-crypto"
import { sessionOptions } from "@/lib/session"
import { getTenantConfig } from "@/lib/tenant-context"
import { getCliente } from "@/lib/erp"
import { classifyIdentifier, LOCKOUT_MS, MAX_FAILED_ATTEMPTS } from "@/lib/portal-auth"
import type { SessionData } from "@/types"

// Mensaje único para credenciales malas: no filtra si el usuario existe.
const GENERIC_ERROR = "Usuario o contraseña incorrectos"

export async function POST(req: NextRequest) {
  try {
    const tenant = await getTenantConfig()
    const body = await req.json().catch(() => null)
    if (!body?.identifier || !body?.password) {
      return NextResponse.json({ error: "Usuario y contraseña requeridos" }, { status: 400 })
    }

    const id = classifyIdentifier(body.identifier)
    const db = getDb()
    const [user] = await db
      .select()
      .from(portalUsers)
      .where(
        and(
          eq(portalUsers.tenantId, tenant.id),
          id.kind === "email" ? eq(portalUsers.email, id.value) : eq(portalUsers.cuit, id.value),
        ),
      )

    if (!user || user.status !== "active") return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 })

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return NextResponse.json(
        { error: "Cuenta bloqueada temporalmente por intentos fallidos. Probá de nuevo en 15 minutos." },
        { status: 429 },
      )
    }

    const ok = await verifyPassword(body.password, user.passwordHash)
    if (!ok) {
      const attempts = user.failedAttempts + 1
      await db
        .update(portalUsers)
        .set({
          failedAttempts: attempts,
          lockedUntil: attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS) : null,
          updatedAt: new Date(),
        })
        .where(eq(portalUsers.id, user.id))
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 })
    }

    // Provisoria vencida: el operador la regenera desde /admin/clientes.
    if (user.mustChangePassword && user.provisionalExpiresAt && user.provisionalExpiresAt < new Date()) {
      return NextResponse.json(
        { error: "Tu clave provisoria venció. Pedile una nueva a tu vendedor." },
        { status: 410 },
      )
    }

    await db
      .update(portalUsers)
      .set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(portalUsers.id, user.id))

    const session = await getIronSession<SessionData>(await cookies(), sessionOptions)

    if (user.mustChangePassword) {
      // Sesión parcial: solo habilita /portal/setup y el link de Google.
      session.isLoggedIn = false
      session.pendingSetup = true
      session.portalUserId = user.id
      await session.save()
      return NextResponse.json({ success: true, redirect: "/portal/setup" })
    }

    const cliente = await getCliente(tenant, user.codigocliente)
    session.isLoggedIn = true
    session.pendingSetup = false
    session.portalUserId = user.id
    session.codigocliente = cliente.codigocliente
    session.razonsocial = cliente.razonsocial
    session.cuit = cliente.cuit
    session.email = user.email ?? undefined
    session.tipoCuenta = cliente.tipoCuenta
    await session.save()
    return NextResponse.json({ success: true, redirect: "/portal/dashboard" })
  } catch (err) {
    console.error("login error:", err)
    return NextResponse.json({ error: "Error interno del servidor" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Probar a mano**

Con un acceso generado en Task 5 (CUIT + provisoria):

Run: `curl -s -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"identifier":"30-57254481-4","password":"<provisoria>"}'`
Expected: `{"success":true,"redirect":"/portal/setup"}` (CUIT con guiones matchea igual — normalización).
Run con contraseña mala 5 veces → la 5ta devuelve el mensaje genérico y la 6ta (aún con la buena) devuelve 429 bloqueada.
Después del lockout: regenerar acceso desde /admin/clientes → login con la nueva provisoria vuelve a andar (destrabe por regeneración).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/auth/login/route.ts
git commit -m "feat(auth): login de clientes por CUIT/email + contraseña con lockout"
```

---

### Task 7: Setup del primer ingreso (API + página)

**Files:**
- Create: `src/app/api/auth/setup/route.ts`
- Create: `src/app/portal/setup/page.tsx`
- Create: `src/components/portal/SetupForm.tsx`

- [ ] **Step 1: API**

```ts
// src/app/api/auth/setup/route.ts
import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { and, eq, ne } from "drizzle-orm"
import { getDb } from "@/db"
import { portalUsers } from "@/db/schema"
import { hashPassword } from "@/lib/admin-crypto"
import { sessionOptions } from "@/lib/session"
import { getTenantConfig } from "@/lib/tenant-context"
import { getCliente } from "@/lib/erp"
import { MIN_PASSWORD_LENGTH } from "@/lib/portal-auth"
import type { SessionData } from "@/types"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Completa el primer ingreso: contraseña definitiva + email (ambos obligatorios).
export async function POST(req: NextRequest) {
  try {
    const tenant = await getTenantConfig()
    const session = await getIronSession<SessionData>(await cookies(), sessionOptions)
    if (!session.pendingSetup || !session.portalUserId) {
      return NextResponse.json({ error: "Sesión de configuración inválida. Ingresá de nuevo." }, { status: 401 })
    }

    const body = await req.json().catch(() => null)
    const password: string = body?.password ?? ""
    const email: string = (body?.email ?? "").trim().toLowerCase()

    if (password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json({ error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres` }, { status: 400 })
    }
    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "Email inválido" }, { status: 400 })
    }

    const db = getDb()
    // El email no puede ser de otro cliente del tenant.
    const [emailTaken] = await db
      .select({ id: portalUsers.id })
      .from(portalUsers)
      .where(and(eq(portalUsers.tenantId, tenant.id), eq(portalUsers.email, email), ne(portalUsers.id, session.portalUserId)))
    if (emailTaken) return NextResponse.json({ error: "Ese email ya está en uso" }, { status: 409 })

    const passwordHash = await hashPassword(password)
    const [user] = await db
      .update(portalUsers)
      .set({ passwordHash, email, mustChangePassword: false, provisionalExpiresAt: null, updatedAt: new Date() })
      .where(eq(portalUsers.id, session.portalUserId))
      .returning()
    if (!user) return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 })

    const cliente = await getCliente(tenant, user.codigocliente)
    session.isLoggedIn = true
    session.pendingSetup = false
    session.codigocliente = cliente.codigocliente
    session.razonsocial = cliente.razonsocial
    session.cuit = cliente.cuit
    session.email = email
    session.tipoCuenta = cliente.tipoCuenta
    await session.save()

    return NextResponse.json({ success: true, redirect: "/portal/dashboard" })
  } catch (err) {
    console.error("setup error:", err)
    return NextResponse.json({ error: "Error interno del servidor" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Página (server) + form (client)**

```tsx
// src/app/portal/setup/page.tsx
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { redirect } from "next/navigation"
import { sessionOptions } from "@/lib/session"
import { getTenantConfig } from "@/lib/tenant-context"
import SetupForm from "@/components/portal/SetupForm"
import type { SessionData } from "@/types"

export default async function SetupPage() {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions)
  if (!session.pendingSetup) redirect(session.isLoggedIn ? "/portal/dashboard" : "/portal")
  const tenant = await getTenantConfig()

  // session.email queda pre-cargado si vinculó Google durante el setup (callback modo link).
  return <SetupForm logoSrc={tenant.logoPath} tenantName={tenant.name} suggestedEmail={session.email ?? ""} />
}
```

```tsx
// src/components/portal/SetupForm.tsx
"use client"

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button, Field, Input } from "@myd-org/ui"
import { Logo } from "@/components/portal/Logo"

export interface SetupFormProps {
  logoSrc: string
  tenantName: string
  suggestedEmail: string
}

export default function SetupForm({ logoSrc, tenantName, suggestedEmail }: SetupFormProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const googleLinked = searchParams.get("linked") === "1"
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [email, setEmail] = useState(suggestedEmail)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    if (password !== confirm) {
      setError("Las contraseñas no coinciden")
      return
    }
    setLoading(true)
    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, email }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Error al guardar")
        return
      }
      router.push(data.redirect)
    } catch {
      setError("Error de conexión. Intentá de nuevo.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-6">
          <Logo src={logoSrc} name={tenantName} size="md" />
        </div>
        <h1 className="text-lg font-semibold text-center mb-1">Configurá tu cuenta</h1>
        <p className="text-sm text-center mb-6" style={{ color: "var(--ink-soft)" }}>
          Elegí tu contraseña definitiva y dejanos tu email para recuperarla si la perdés.
        </p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Field label="Email">
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@empresa.com" />
          </Field>
          <Field label="Nueva contraseña">
            <Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Repetir contraseña">
            <Input type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" disabled={loading}>
            {loading ? "Guardando…" : "Guardar y entrar"}
          </Button>
        </form>
        <div className="mt-4 text-center">
          {googleLinked ? (
            <p className="text-sm text-green-700">Google vinculado ✓ — completá el resto para terminar.</p>
          ) : (
            <a href="/api/auth/google/start?mode=link" className="text-sm underline">
              Vincular Google para entrar con un click
            </a>
          )}
        </div>
      </div>
    </main>
  )
}
```

- [ ] **Step 3: Probar el flujo completo a mano**

1. Generar acceso en `/admin/clientes` → copiar provisoria.
2. En el portal: login CUIT + provisoria → redirige a `/portal/setup`.
3. Completar contraseña + email → dashboard.
4. Logout → login CUIT + contraseña nueva → dashboard directo (sin setup).
5. Login por email + contraseña → también entra.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/auth/setup/route.ts src/app/portal/setup/page.tsx src/components/portal/SetupForm.tsx
git commit -m "feat(auth): setup del primer ingreso (contraseña definitiva + email)"
```

---

### Task 8: Google OAuth (lib + start + callback)

**Files:**
- Create: `src/lib/google-oauth.ts`
- Create: `src/app/api/auth/google/start/route.ts`
- Create: `src/app/api/auth/google/callback/route.ts`

- [ ] **Step 1: Instalar la dependencia**

Run: `npm install google-auth-library`
Expected: agrega a package.json (sin peer conflicts).

- [ ] **Step 2: Lib wrapper**

```ts
// src/lib/google-oauth.ts
import { OAuth2Client } from "google-auth-library"

// Wrapper mínimo del flujo authorization-code de Google. Solo se usa para
// login/link del portal: pide openid+email, devuelve el sub (googleId) verificado.

function getClient(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const redirectUri = process.env.GOOGLE_REDIRECT_URI
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI")
  }
  return new OAuth2Client(clientId, clientSecret, redirectUri)
}

export function buildGoogleAuthUrl(state: string): string {
  return getClient().generateAuthUrl({ scope: ["openid", "email"], state, prompt: "select_account" })
}

/** Intercambia el code y verifica el id_token. Devuelve el sub estable + email. */
export async function verifyGoogleCode(code: string): Promise<{ googleId: string; email: string | null }> {
  const client = getClient()
  const { tokens } = await client.getToken(code)
  if (!tokens.id_token) throw new Error("Google no devolvió id_token")
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID })
  const payload = ticket.getPayload()
  if (!payload?.sub) throw new Error("id_token sin sub")
  return { googleId: payload.sub, email: payload.email?.toLowerCase() ?? null }
}
```

- [ ] **Step 3: Start route**

```ts
// src/app/api/auth/google/start/route.ts
import { randomBytes } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { oauthStateSessionOptions, sessionOptions, type OAuthStateSession } from "@/lib/session"
import { buildGoogleAuthUrl } from "@/lib/google-oauth"
import type { SessionData } from "@/types"

// Inicia el round-trip OAuth. mode=login (default) | link.
// link exige una sesión pending-setup o completa: sin sesión no hay a qué vincular.
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get("mode") === "link" ? "link" : "login"

  if (mode === "link") {
    const session = await getIronSession<SessionData>(await cookies(), sessionOptions)
    if (!session.portalUserId || (!session.pendingSetup && !session.isLoggedIn)) {
      return NextResponse.redirect(new URL("/portal", req.nextUrl.origin))
    }
  }

  const state = randomBytes(16).toString("hex")
  const oauth = await getIronSession<OAuthStateSession>(await cookies(), oauthStateSessionOptions)
  oauth.state = state
  oauth.mode = mode
  await oauth.save()

  return NextResponse.redirect(buildGoogleAuthUrl(state))
}
```

- [ ] **Step 4: Callback route (doble modo)**

```ts
// src/app/api/auth/google/callback/route.ts
import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { and, eq, ne } from "drizzle-orm"
import { getDb } from "@/db"
import { portalUsers } from "@/db/schema"
import { oauthStateSessionOptions, sessionOptions, type OAuthStateSession } from "@/lib/session"
import { verifyGoogleCode } from "@/lib/google-oauth"
import { getTenantConfig } from "@/lib/tenant-context"
import { getCliente } from "@/lib/erp"
import type { SessionData } from "@/types"

function loginRedirect(origin: string, error?: string) {
  const url = new URL("/portal", origin)
  if (error) url.searchParams.set("error", error)
  return NextResponse.redirect(url)
}

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin
  try {
    const code = req.nextUrl.searchParams.get("code")
    const state = req.nextUrl.searchParams.get("state")

    const oauth = await getIronSession<OAuthStateSession>(await cookies(), oauthStateSessionOptions)
    const expectedState = oauth.state
    const mode = oauth.mode ?? "login"
    oauth.destroy() // el state es de un solo uso

    if (!code || !state || !expectedState || state !== expectedState) {
      return loginRedirect(origin, "oauth")
    }

    const tenant = await getTenantConfig()
    const { googleId, email } = await verifyGoogleCode(code)
    const db = getDb()
    const session = await getIronSession<SessionData>(await cookies(), sessionOptions)

    if (mode === "link") {
      // Vincular a la cuenta de la sesión activa (pending-setup o completa).
      if (!session.portalUserId || (!session.pendingSetup && !session.isLoggedIn)) {
        return loginRedirect(origin, "oauth")
      }
      // El googleId no puede estar en otra cuenta del tenant.
      const [taken] = await db
        .select({ id: portalUsers.id })
        .from(portalUsers)
        .where(and(eq(portalUsers.tenantId, tenant.id), eq(portalUsers.googleId, googleId), ne(portalUsers.id, session.portalUserId)))
      if (taken) return loginRedirect(origin, "google-en-uso")

      await db
        .update(portalUsers)
        .set({ googleId, updatedAt: new Date() })
        .where(eq(portalUsers.id, session.portalUserId))

      if (session.pendingSetup) {
        // Pre-carga el email de Google para el form de setup (editable).
        if (!session.email && email) {
          session.email = email
          await session.save()
        }
        return NextResponse.redirect(new URL("/portal/setup?linked=1", origin))
      }
      return NextResponse.redirect(new URL("/portal/dashboard", origin))
    }

    // mode === "login": Google solo resuelve cuentas YA vinculadas.
    const [user] = await db
      .select()
      .from(portalUsers)
      .where(and(eq(portalUsers.tenantId, tenant.id), eq(portalUsers.googleId, googleId)))

    if (!user || user.status !== "active") return loginRedirect(origin, "google-no-vinculado")

    if (user.mustChangePassword) {
      // Vinculó durante el setup pero no lo terminó: retomarlo.
      session.isLoggedIn = false
      session.pendingSetup = true
      session.portalUserId = user.id
      await session.save()
      return NextResponse.redirect(new URL("/portal/setup", origin))
    }

    const cliente = await getCliente(tenant, user.codigocliente)
    await db
      .update(portalUsers)
      .set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(portalUsers.id, user.id))

    session.isLoggedIn = true
    session.pendingSetup = false
    session.portalUserId = user.id
    session.codigocliente = cliente.codigocliente
    session.razonsocial = cliente.razonsocial
    session.cuit = cliente.cuit
    session.email = user.email ?? undefined
    session.tipoCuenta = cliente.tipoCuenta
    await session.save()
    return NextResponse.redirect(new URL("/portal/dashboard", origin))
  } catch (err) {
    console.error("google callback error:", err)
    return loginRedirect(origin, "oauth")
  }
}
```

- [ ] **Step 5: Probar a mano (requiere GOOGLE_* en .env.local)**

1. `/api/auth/google/start?mode=login` sin cuenta vinculada → vuelve a `/portal?error=google-no-vinculado`.
2. Login provisoria → setup → "Vincular Google" → elegir cuenta → vuelve a `/portal/setup?linked=1` con email pre-cargado.
3. Completar setup → logout → "Entrar con Google" → dashboard directo.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/google-oauth.ts src/app/api/auth/google/
git commit -m "feat(auth): login y vinculación con Google (OAuth manual, state CSRF)"
```

---

### Task 9: Recuperación por email (forgot + reset)

**Files:**
- Create: `src/app/api/auth/forgot/route.ts`
- Create: `src/app/api/auth/reset/route.ts`
- Create: `src/app/portal/reset/[token]/page.tsx`
- Create: `src/components/portal/ResetForm.tsx`

- [ ] **Step 1: Forgot (siempre OK; cooldown 5 min por usuario)**

```ts
// src/app/api/auth/forgot/route.ts
import { NextRequest, NextResponse } from "next/server"
import { and, desc, eq } from "drizzle-orm"
import { Resend } from "resend"
import { getDb } from "@/db"
import { portalPasswordTokens, portalUsers } from "@/db/schema"
import { generateToken } from "@/lib/admin-crypto"
import { getTenantConfig } from "@/lib/tenant-context"
import { RESET_COOLDOWN_MS, RESET_TOKEN_TTL_MS } from "@/lib/portal-auth"

// Siempre responde OK: no filtra si el email existe (mismo patrón que el admin).
export async function POST(req: NextRequest) {
  const ok = NextResponse.json({ ok: true })
  try {
    const tenant = await getTenantConfig()
    const body = await req.json().catch(() => null)
    const email: string = (body?.email ?? "").trim().toLowerCase()
    if (!email) return ok

    const db = getDb()
    const [user] = await db
      .select()
      .from(portalUsers)
      .where(and(eq(portalUsers.tenantId, tenant.id), eq(portalUsers.email, email), eq(portalUsers.status, "active")))
    if (!user) return ok

    // Cooldown en DB: máximo 1 token cada 5 minutos (rate-limit que funciona en serverless).
    const [lastToken] = await db
      .select({ createdAt: portalPasswordTokens.createdAt })
      .from(portalPasswordTokens)
      .where(eq(portalPasswordTokens.portalUserId, user.id))
      .orderBy(desc(portalPasswordTokens.createdAt))
      .limit(1)
    if (lastToken && Date.now() - lastToken.createdAt.getTime() < RESET_COOLDOWN_MS) return ok

    const { token, tokenHash } = generateToken()
    await db.insert(portalPasswordTokens).values({
      portalUserId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    })

    const resetUrl = `${req.nextUrl.origin}/portal/reset/${token}`
    const resend = new Resend(process.env.RESEND_API_KEY)
    await resend.emails.send({
      from: tenant.resendFrom || "noreply@example.com",
      to: email,
      subject: `Recuperar contraseña — Portal ${tenant.name}`,
      html: `
        <p>Pediste restablecer tu contraseña del portal de ${tenant.name}.</p>
        <p><a href="${resetUrl}">Crear una contraseña nueva</a></p>
        <p>El link vence en 1 hora. Si no lo pediste, ignorá este email.</p>
      `,
    })
    return ok
  } catch (err) {
    console.error("forgot error:", err)
    return ok
  }
}
```

- [ ] **Step 2: Reset (consume el token; también destraba lockout)**

```ts
// src/app/api/auth/reset/route.ts
import { NextRequest, NextResponse } from "next/server"
import { and, eq, gt, isNull } from "drizzle-orm"
import { getDb } from "@/db"
import { portalPasswordTokens, portalUsers } from "@/db/schema"
import { hashPassword, hashToken } from "@/lib/admin-crypto"
import { MIN_PASSWORD_LENGTH } from "@/lib/portal-auth"

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body?.token || !body?.password) {
    return NextResponse.json({ error: "token y contraseña requeridos" }, { status: 400 })
  }
  if (body.password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres` }, { status: 400 })
  }

  const db = getDb()
  const tokenHash = hashToken(body.token)
  const [tokenRow] = await db
    .select()
    .from(portalPasswordTokens)
    .where(
      and(
        eq(portalPasswordTokens.tokenHash, tokenHash),
        isNull(portalPasswordTokens.usedAt),
        gt(portalPasswordTokens.expiresAt, new Date()),
      ),
    )
  if (!tokenRow) return NextResponse.json({ error: "Link inválido o vencido" }, { status: 400 })

  const passwordHash = await hashPassword(body.password)
  await Promise.all([
    db
      .update(portalUsers)
      .set({
        passwordHash,
        mustChangePassword: false,
        provisionalExpiresAt: null,
        failedAttempts: 0,
        lockedUntil: null, // el reset también destraba el lockout
        updatedAt: new Date(),
      })
      .where(eq(portalUsers.id, tokenRow.portalUserId)),
    db.update(portalPasswordTokens).set({ usedAt: new Date() }).where(eq(portalPasswordTokens.id, tokenRow.id)),
  ])

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Página de reset**

```tsx
// src/app/portal/reset/[token]/page.tsx
import { getTenantConfig } from "@/lib/tenant-context"
import ResetForm from "@/components/portal/ResetForm"

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const tenant = await getTenantConfig()
  return <ResetForm token={token} logoSrc={tenant.logoPath} tenantName={tenant.name} />
}
```

```tsx
// src/components/portal/ResetForm.tsx
"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button, Field, Input } from "@myd-org/ui"
import { Logo } from "@/components/portal/Logo"

export default function ResetForm({ token, logoSrc, tenantName }: { token: string; logoSrc: string; tenantName: string }) {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [done, setDone] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    if (password !== confirm) {
      setError("Las contraseñas no coinciden")
      return
    }
    setLoading(true)
    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Error al restablecer")
        return
      }
      setDone(true)
      setTimeout(() => router.push("/portal"), 1500)
    } catch {
      setError("Error de conexión. Intentá de nuevo.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-6">
          <Logo src={logoSrc} name={tenantName} size="md" />
        </div>
        <h1 className="text-lg font-semibold text-center mb-6">Nueva contraseña</h1>
        {done ? (
          <p className="text-center text-sm text-green-700">Contraseña actualizada ✓ — redirigiendo al login…</p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Field label="Nueva contraseña">
              <Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="Repetir contraseña">
              <Input type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" disabled={loading}>
              {loading ? "Guardando…" : "Guardar"}
            </Button>
          </form>
        )}
      </div>
    </main>
  )
}
```

- [ ] **Step 4: Probar a mano**

1. `POST /api/auth/forgot {"email":"<email del setup>"}` → 200 `{ok:true}`; llega email (o dry-run log si Resend no está en dev).
2. Segundo POST inmediato → 200 pero NO crea token nuevo (cooldown; verificar en DB: un solo row nuevo).
3. Abrir el link `/portal/reset/<token>` → nueva contraseña → login con ella OK.
4. Reusar el mismo link → "Link inválido o vencido".

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/forgot/route.ts src/app/api/auth/reset/route.ts src/app/portal/reset/ src/components/portal/ResetForm.tsx
git commit -m "feat(auth): recuperación de contraseña por email con cooldown"
```

---

### Task 10: LoginPage — reemplazar OTP por contraseña + Google, y borrar el OTP

**Files:**
- Modify: `src/components/portal/LoginPage.tsx` (480 líneas; conservar layout/estilos/tab "tienda")
- Delete: `src/app/api/auth/send-code/route.ts`, `src/app/api/auth/verify-code/route.ts`
- Modify: `src/types/index.ts` (borrar `OtpSessionData`), `src/lib/session.ts` (borrar `otpSessionOptions`)

- [ ] **Step 1: Rework de `LoginPage.tsx`**

Leer el archivo completo primero. Conservar: wrapper/layout, `Logo`, Tabs con la pestaña "tienda", manejo de `?redirect=`. Eliminar: estado `otp`, `countdown`, refs de OTP, `handleSendCode`, `handleVerifyCode`, el step `"otp"` y su JSX. Reemplazar el step `"identify"` por un único form de credenciales:

```tsx
// Estado nuevo (reemplaza identifier/otp/countdown):
const [identifier, setIdentifier] = useState("")
const [password, setPassword] = useState("")
const [forgotMode, setForgotMode] = useState(false)
const [forgotSent, setForgotSent] = useState(false)
const [loading, setLoading] = useState(false)
const [error, setError] = useState("")

// Errores del callback de Google llegan por query (?error=...):
const googleError = searchParams.get("error")
const GOOGLE_ERRORS: Record<string, string> = {
  "google-no-vinculado": "Tu cuenta de Google no está asociada. Ingresá con CUIT y la contraseña que te pasaron.",
  "google-en-uso": "Esa cuenta de Google ya está vinculada a otro cliente.",
  oauth: "No pudimos completar el ingreso con Google. Probá de nuevo.",
}

async function handleLogin(e: React.FormEvent) {
  e.preventDefault()
  setError("")
  setLoading(true)
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password, redirectTo }),
    })
    const data = await res.json()
    if (!res.ok) {
      setError(data.error ?? "Error al ingresar")
      return
    }
    router.push(data.redirect)
  } catch {
    setError("Error de conexión. Intentá de nuevo.")
  } finally {
    setLoading(false)
  }
}

async function handleForgot(e: React.FormEvent) {
  e.preventDefault()
  setLoading(true)
  try {
    await fetch("/api/auth/forgot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: identifier }),
    })
    setForgotSent(true)
  } finally {
    setLoading(false)
  }
}
```

JSX del form (dentro del layout existente, mismo lugar donde estaba el form de `identify`):

```tsx
{forgotMode ? (
  forgotSent ? (
    <p className="text-sm text-center">Si el email está registrado, te mandamos un link para restablecer la contraseña.</p>
  ) : (
    <form onSubmit={handleForgot} className="flex flex-col gap-4">
      <Field label="Tu email">
        <Input type="email" required value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="tu@empresa.com" />
      </Field>
      <Button type="submit" disabled={loading}>{loading ? "Enviando…" : "Enviarme el link"}</Button>
      <button type="button" className="text-sm underline" onClick={() => setForgotMode(false)}>Volver</button>
    </form>
  )
) : (
  <form onSubmit={handleLogin} className="flex flex-col gap-4">
    <Field label="CUIT o email">
      <Input required value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="30-12345678-9" />
    </Field>
    <Field label="Contraseña">
      <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
    </Field>
    {(error || (googleError && GOOGLE_ERRORS[googleError])) && (
      <p className="text-sm text-red-600">{error || GOOGLE_ERRORS[googleError!]}</p>
    )}
    <Button type="submit" disabled={loading}>{loading ? "Ingresando…" : "Ingresar"}</Button>
    <button type="button" className="text-sm underline self-center" onClick={() => setForgotMode(true)}>
      Olvidé mi contraseña
    </button>
    <div className="flex items-center gap-3 my-1">
      <div className="h-px flex-1 bg-line" /><span className="text-xs text-subtle">o</span><div className="h-px flex-1 bg-line" />
    </div>
    <Button variant="secondary" type="button" onClick={() => { window.location.href = "/api/auth/google/start?mode=login" }}>
      Entrar con Google
    </Button>
  </form>
)}
```

Nota: si `Button` de `@myd-org/ui` no tiene `variant="secondary"`, usar el estilo que tenga el design system (revisar sus props al editar).

- [ ] **Step 2: Borrar el OTP**

```bash
rm src/app/api/auth/send-code/route.ts src/app/api/auth/verify-code/route.ts
rmdir src/app/api/auth/send-code src/app/api/auth/verify-code
```

En `src/types/index.ts`: borrar la interfaz `OtpSessionData`.
En `src/lib/session.ts`: borrar `otpSessionOptions` y el re-export de `OtpSessionData`.
Verificar que nadie más los importa: `grep -rn "OtpSessionData\|otpSessionOptions\|send-code\|verify-code" src/` → sin hits (fuera de los archivos borrados).

- [ ] **Step 3: Verificar compilación + tests + build**

Run: `npx tsc --noEmit && npm run test && npm run build`
Expected: todo verde.

- [ ] **Step 4: Probar el login completo en el navegador**

`/portal`: login CUIT+contraseña OK, "Olvidé mi contraseña" manda el mail, "Entrar con Google" redirige a Google. Tab "tienda" intacta.

- [ ] **Step 5: Commit**

```bash
git add -A src/
git commit -m "feat(auth)!: login por contraseña + Google en el portal; adiós OTP"
```

---

### Task 11: Verificación final y deploy

- [ ] **Step 1: Suite completa**

Run: `npm run test && npm run build && npm run alegra:smoke -- --tenant central-led`
Expected: todo verde.

- [ ] **Step 2: Checklist manual E2E (dev)**

1. Admin genera acceso → provisoria visible una vez.
2. Login provisoria → setup → contraseña + email → dashboard.
3. Re-login por CUIT (con y sin guiones) y por email.
4. 5 contraseñas malas → lockout → regenerar desde admin destraba.
5. Vincular Google en setup → logout → "Entrar con Google" → dashboard.
6. Google sin vincular → error claro en /portal.
7. Forgot → email → reset → login con la nueva.
8. `/portal/setup` sin sesión pendiente → redirige a /portal.

- [ ] **Step 3: Deploy (requiere confirmación del usuario)**

1. Cargar `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` en Vercel.
2. Correr la migración contra Neon (**confirmar con el usuario antes**): `DATABASE_URL=<neon> npx tsx src/db/migrate.ts`.
3. `git push origin main` → deploy automático.
4. Repetir checklist E2E en prod con un cliente de prueba.

---

## Self-review (hecho al escribir el plan)

- **Cobertura del spec**: tablas (T2), alta/regeneración (T4-5), primer ingreso (T6-7), Google login|link (T8), recuperación+cooldown (T9), lockout+destrabe (T6/T4/T9), CUIT normalizado (T1/T4/T6), email obligatorio (T7), reemplazo OTP (T10), config externa (prerrequisitos), fuera de alcance respetado.
- **Sin placeholders**: todo código completo; el único paso "leer antes de editar" es LoginPage.tsx (480 líneas existentes que se conservan parcialmente — el código nuevo está completo arriba).
- **Consistencia de tipos**: `portalUsers`/`portalPasswordTokens` (T2) usados con esos nombres en T4/T6/T7/T8/T9; `SessionData.pendingSetup/portalUserId` (T3) en T6/T7/T8; constantes de `portal-auth` (T1) en T4/T6/T7/T9.
