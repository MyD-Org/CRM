import { getGuardedAdminSession } from "@/lib/admin-session"
import { roleRank } from "@/lib/roles"

// Guard de las rutas /api/admin/* nuevas (comprobantes de pago, settings de comprobantes).
// Se construye sobre `getGuardedAdminSession`: el ROL y el TENANT autoritativos son los de la
// FILA de admin_users / del host verificado, nunca `session.role` ni `session.tenantId` de la
// cookie (pueden estar viejos — el D8 del design prohíbe copiar ese patrón de las rutas viejas).
//
// Política: guard falla → 401 (el `reason` interno va SOLO a logs: no serializarlo al body,
// sería un oráculo); rol con rank < 1 (operator) → 404 con el cuerpo IDÉNTICO al de un id
// inexistente, así un operator no puede distinguir "no tengo acceso" de "no existe".

const NO_STORE = { "Cache-Control": "private, no-store" }

export function adminUnauthorizedResponse(): Response {
  return Response.json({ error: "No autorizado", code: "unauthorized" }, { status: 401, headers: NO_STORE })
}

/**
 * 404 de las rutas admin nuevas. Es EL MISMO helper para el guard (operator) y para los
 * "id inexistente / de otro tenant" que traduce la ruta desde un repo null — la identidad del
 * cuerpo entre ambos casos es lo que cierra el oráculo de existencia.
 */
export function adminNotFoundResponse(): Response {
  return Response.json({ error: "No encontrado", code: "not_found" }, { status: 404, headers: NO_STORE })
}

export interface AdminGuardUser {
  id: string
  name: string
  email: string
  role: string
}

export type AdminGuardResult =
  | { ok: true; tenantId: string; user: AdminGuardUser }
  | { ok: false; response: Response }

/**
 * Autoriza una ruta admin "nueva" (admin+). Uso en la route handler:
 *
 *   const guard = await requireAdminPlus(req)
 *   if (!guard.ok) return guard.response
 *   // …todo lo de abajo con `guard.tenantId` como ÚNICO tenant, y `guard.user` como actor.
 */
export async function requireAdminPlus(req: Request): Promise<AdminGuardResult> {
  const guarded = await getGuardedAdminSession(req)
  if (!guarded.ok) {
    console.warn(`[admin-guard] request rechazado: ${guarded.reason}`)
    return { ok: false, response: adminUnauthorizedResponse() }
  }
  // `user.role` es el de la fila fresca (getGuardedAdminSession lo leyó de la DB).
  if (roleRank(guarded.user.role) < 1) {
    return { ok: false, response: adminNotFoundResponse() }
  }
  return { ok: true, tenantId: guarded.tenantId, user: guarded.user }
}
