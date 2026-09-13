import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptions } from "@/lib/session"
import { resolveRequestTenantId } from "@/lib/tenant-context"
import { getTenantByIdFromDb, type TenantConfig } from "@/lib/tenants"
import type { SessionData } from "@/types"

// Guard de las rutas /api/portal/* nuevas (comprobantes de pago). Tercer invariante del
// design: el cliente sale de la SESIÓN del portal (codigocliente, nunca del body) y el tenant
// del HOST verificado por `resolveRequestTenantId` — no `getTenantConfig()`, que lee
// `x-tenant-id` para branding, no para seguridad.
//
// Fallas → 401 con el cuerpo común (el motivo interno va solo a logs). El llamador:
//
//   const guard = await requirePortalClient(req)
//   if (!guard.ok) return guard.response

const NO_STORE = { "Cache-Control": "private, no-store" }

function unauthorizedResponse(): Response {
  return Response.json({ error: "No autorizado", code: "unauthorized" }, { status: 401, headers: NO_STORE })
}

export type PortalGuardResult =
  | { ok: true; session: SessionData; tenantId: string; config: TenantConfig }
  | { ok: false; response: Response }

export async function requirePortalClient(req: Request): Promise<PortalGuardResult> {
  const cookieStore = await cookies()
  const iron = await getIronSession<SessionData>(cookieStore, sessionOptions)
  if (!iron.isLoggedIn || !iron.codigocliente) {
    return { ok: false, response: unauthorizedResponse() }
  }

  const tenantId = await resolveRequestTenantId(req)
  if (!tenantId) {
    console.warn("[portal-guard] tenant no resoluble para el host del request")
    return { ok: false, response: unauthorizedResponse() }
  }

  const config = await getTenantByIdFromDb(tenantId)
  if (!config) {
    // resolveRequestTenantId ya validó el id contra el registro; acá solo cae una carrera
    // de baja de tenant. Se responde igual que sin sesión: nada de oráculos.
    console.warn(`[portal-guard] sin config para tenant "${tenantId}"`)
    return { ok: false, response: unauthorizedResponse() }
  }

  const session: SessionData = {
    isLoggedIn: iron.isLoggedIn,
    codigocliente: iron.codigocliente,
    razonsocial: iron.razonsocial,
    cuit: iron.cuit,
    email: iron.email,
    tipoCuenta: iron.tipoCuenta,
  }
  return { ok: true, session, tenantId, config }
}
