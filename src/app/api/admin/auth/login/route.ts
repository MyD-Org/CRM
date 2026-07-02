import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers } from "@/db/schema"
import { verifyPassword } from "@/lib/admin-crypto"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

// ── Límite de intentos de login ────────────────────────────────────────────
// Store en memoria del proceso, con ventana deslizante + bloqueo temporal por
// email. No hay tabla ni Redis para esto y el login admin es de bajo volumen, así
// que un Map acotado alcanza para production-ready.
// CAVEATS (ver reporte): (1) por-proceso — no se comparte entre instancias y se
// reinicia con el deploy; (2) la clave es el email, así que un tercero podría
// forzar el bloqueo temporal de una cuenta ajena (DoS acotado a LOGIN_LOCK_MS).
const MAX_LOGIN_ATTEMPTS = 5
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_LOCK_MS = 15 * 60 * 1000

type AttemptBucket = { count: number; firstAt: number; lockedUntil: number }
const loginAttempts = new Map<string, AttemptBucket>()

// Limpieza oportunista para acotar el tamaño del Map.
function sweep(now: number) {
  for (const [key, b] of loginAttempts) {
    if (b.lockedUntil <= now && now - b.firstAt > LOGIN_WINDOW_MS) {
      loginAttempts.delete(key)
    }
  }
}

function isLocked(key: string, now: number): boolean {
  const b = loginAttempts.get(key)
  return !!b && b.lockedUntil > now
}

function recordFailure(key: string, now: number) {
  let b = loginAttempts.get(key)
  if (!b || now - b.firstAt > LOGIN_WINDOW_MS) {
    b = { count: 0, firstAt: now, lockedUntil: 0 }
  }
  b.count += 1
  if (b.count >= MAX_LOGIN_ATTEMPTS) {
    b.lockedUntil = now + LOGIN_LOCK_MS
  }
  loginAttempts.set(key, b)
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body?.email || !body?.password) {
    return NextResponse.json({ error: "email y contraseña requeridos" }, { status: 400 })
  }

  const email = body.email.toLowerCase()
  const now = Date.now()
  sweep(now)

  if (isLocked(email, now)) {
    return NextResponse.json(
      { error: "Demasiados intentos fallidos. Probá de nuevo en unos minutos." },
      { status: 429 },
    )
  }

  const db = getDb()
  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.email, email))

  // Respuesta genérica para no filtrar si el email existe
  if (!user || !user.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
    recordFailure(email, now)
    return NextResponse.json({ error: "Credenciales incorrectas" }, { status: 401 })
  }

  loginAttempts.delete(email) // login exitoso → reinicia el contador

  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  session.userId = user.id
  session.name = user.name
  session.email = user.email
  session.role = user.role as AdminSessionData["role"]
  session.tenantId = user.tenantId
  await session.save()

  return NextResponse.json({ ok: true })
}
