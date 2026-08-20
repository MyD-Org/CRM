import { cookies } from "next/headers"
import { getIronSession, type IronSession, type SessionOptions } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers } from "@/db/schema"
import { SESSION_SECRET } from "@/lib/session-secret"
import { resolveRequestTenantId } from "@/lib/tenant-context"

export interface AdminSessionData {
  userId: string
  name: string
  email: string
  role: "operator" | "admin" | "superadmin"
  tenantId: string
}

export const adminSessionOptions: SessionOptions = {
  password: SESSION_SECRET,
  cookieName: "admin-session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
  },
}

/** Motivo del rechazo del guard. Es para LOGS server-side: MUST NOT serializarse a un body. */
export type GuardFailReason =
  | "no-session"
  | "no-tenant"
  | "tenant-mismatch"
  | "user-gone"
  | "inactive"

export type GuardedSession =
  | {
      ok: true
      session: IronSession<AdminSessionData>
      tenantId: string
      user: {
        id: string
        name: string
        email: string
        role: AdminSessionData["role"]
        availability: string
      }
    }
  | { ok: false; reason: GuardFailReason }

/**
 * Sesión + tenant del request + verificación contra la DB, en un solo `select`.
 *
 * **No lanza y no redirige**: devuelve una unión discriminada. Los dos consumidores reaccionan
 * distinto — una página hace `redirect()`, una ruta API devuelve 401 (o 404 en `assign`, para no
 * filtrar existencia) — así que quien decide el status es el llamador. Y una excepción en un
 * Server Component la agarra el error boundary y renderiza una pantalla de error en vez de
 * redirigir; sumar otro flujo por excepciones junto al `NEXT_REDIRECT` de `redirect()` invita a
 * tragárselo en un `catch` genérico.
 *
 * `reason` NUNCA va al body de una respuesta: sería el oráculo de enumeración que la spec prohíbe.
 *
 * Orden de verificación: barato antes que caro, cerrado en cada paso.
 *   1. sin `session.userId`         → `no-session`      (sin consultar `admin_users`)
 *   2. tenant del request `null`    → `no-tenant`
 *   3. cookie.tenantId ≠ request    → `tenant-mismatch` (corta ANTES de la DB: es el caso de
 *                                      volumen, las sesiones vivas emitidas antes del fix)
 *   4. fila inexistente             → `user-gone`       (cuenta borrada)
 *   5. fila.tenantId ≠ request      → `tenant-mismatch` (usuario movido de tenant)
 *   6. `passwordHash === null`      → `inactive`        (invitación pendiente / desactivada)
 *   7. rol distinto al de la cookie → se USA el de la fila, no expulsa (refresh, no expulsión)
 *
 * El `select` es el que el layout protegido ya hacía (traía solo `availability`): se le suman
 * columnas, sin round-trips nuevos.
 *
 * Pasar el `Request` donde esté a mano (Route Handlers). El layout no lo tiene: cae a `headers()`.
 */
export async function getGuardedAdminSession(req?: Request): Promise<GuardedSession> {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return { ok: false, reason: "no-session" }

  const tenantId = await resolveRequestTenantId(req)
  if (!tenantId) return { ok: false, reason: "no-tenant" }
  if (session.tenantId !== tenantId) return { ok: false, reason: "tenant-mismatch" }

  const [me] = await getDb()
    .select({
      id: adminUsers.id,
      name: adminUsers.name,
      email: adminUsers.email,
      role: adminUsers.role,
      availability: adminUsers.availability,
      tenantId: adminUsers.tenantId,
      passwordHash: adminUsers.passwordHash,
    })
    .from(adminUsers)
    .where(eq(adminUsers.id, session.userId))

  if (!me) return { ok: false, reason: "user-gone" }
  if (me.tenantId !== tenantId) return { ok: false, reason: "tenant-mismatch" }
  if (me.passwordHash === null) return { ok: false, reason: "inactive" }

  return {
    ok: true,
    session,
    tenantId,
    // `role` viene de la DB, no de la cookie: si se lo cambiaron, manda la fila. No se persiste
    // en la sesión — `session.save()` tampoco se puede llamar desde un Server Component.
    user: {
      id: me.id,
      name: me.name,
      email: me.email,
      role: me.role as AdminSessionData["role"],
      availability: me.availability,
    },
  }
}
