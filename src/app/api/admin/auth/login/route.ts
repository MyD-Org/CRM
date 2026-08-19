import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { and, eq } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers } from "@/db/schema"
import { verifyPassword } from "@/lib/admin-crypto"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { resolveRequestTenantId } from "@/lib/tenant-context"

// ── Hash dummy para timing parejo ──────────────────────────────────────────
// Cuando no hay fila que matchee (email, tenant) —o la fila es una invitación
// pendiente sin contraseña— igual se corre `verifyPassword` contra esta constante
// y se descarta el resultado: si no, la ausencia de la cuenta queda observable por
// latencia (un scrypt de 64 bytes es medible).
//
// TIENE que estar BIEN FORMADO: `verifyPassword` (src/lib/admin-crypto.ts) hace
// `stored.split(":")` y devuelve false SIN correr scrypt si falta salt o hash, y
// vuelve a cortar antes del `timingSafeEqual` si el largo no coincide. Un dummy
// chapucero ("x", "a:b") no empareja nada y deja el canal abierto en silencio.
// Formato: <32 hex de salt>:<128 hex de hash> (64 bytes), igual que `hashPassword`.
const DUMMY_PASSWORD_HASH =
  "584c495b6e8f09f9bd302132c95cbe48:" +
  "a2ba3887d12a0f1db1875907c6124d9b7dcbed0fd1225f787f292ffff4ec7d26" +
  "792b0bff27357f725bd408d48755f81888b5c5a1b67424b30dbd54d3bbcfad3e"

// ── Límite de intentos de login ────────────────────────────────────────────
// Store en memoria del proceso, con ventana deslizante + bloqueo temporal por
// (tenant, email). No hay tabla ni Redis para esto y el login admin es de bajo
// volumen, así que un Map acotado alcanza para production-ready.
// CAVEATS (ver reporte): (1) por-proceso — no se comparte entre instancias y se
// reinicia con el deploy; (2) la clave incluye el email, así que un tercero podría
// forzar el bloqueo temporal de una cuenta ajena (DoS acotado a LOGIN_LOCK_MS)
// dentro de ESE tenant — antes la clave era solo el email y el bloqueo cruzaba a
// todos los tenants donde esa persona tuviera cuenta.
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
  // El tenant sale del HOST, no de la fila de admin_users: una credencial válida de un
  // tenant no autentica en otro. Se le pasa el `req` explícitamente porque `headers()`
  // no está disponible/poblado en todos los contextos desde los que corre este handler.
  const tenantId = await resolveRequestTenantId(req)

  // Host no resoluble → 401 genérico sin consultar credenciales, sin emitir sesión y
  // sin registrar el fallo en ninguna cubeta de rate limit (una clave sin tenant
  // colisionaría con la de un tenant real y sería un DoS gratis).
  if (!tenantId) {
    return NextResponse.json({ error: "Credenciales incorrectas" }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  if (!body?.email || !body?.password) {
    return NextResponse.json({ error: "email y contraseña requeridos" }, { status: 400 })
  }

  const email = body.email.toLowerCase()
  const attemptKey = `${tenantId}:${email}`
  const now = Date.now()
  sweep(now)

  if (isLocked(attemptKey, now)) {
    return NextResponse.json(
      { error: "Demasiados intentos fallidos. Probá de nuevo en unos minutos." },
      { status: 429 },
    )
  }

  const db = getDb()
  const [user] = await db
    .select()
    .from(adminUsers)
    .where(and(eq(adminUsers.email, email), eq(adminUsers.tenantId, tenantId)))

  // Cuenta "activa" = con contraseña seteada. Una invitación pendiente
  // (`password_hash IS NULL`) recibe exactamente el mismo trato que "sin fila",
  // hash dummy incluido.
  const storedHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH
  const passwordOk = await verifyPassword(body.password, storedHash)

  // Respuesta genérica para no filtrar si el email existe (en este tenant o en otro).
  if (!user || !user.passwordHash || !passwordOk) {
    recordFailure(attemptKey, now)
    return NextResponse.json({ error: "Credenciales incorrectas" }, { status: 401 })
  }

  loginAttempts.delete(attemptKey) // login exitoso → reinicia SOLO el contador de este tenant

  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  session.userId = user.id
  session.name = user.name
  session.email = user.email
  session.role = user.role as AdminSessionData["role"]
  // El tenant del host, que por la query de arriba es el mismo que `user.tenantId`.
  session.tenantId = tenantId
  await session.save()

  return NextResponse.json({ ok: true })
}
