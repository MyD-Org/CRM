import { verifyAgentToken } from "@/lib/agent-token"
import { secureCompare } from "@/lib/secure-compare"

// Auth compartida de los endpoints /api/agent/*: Bearer token minteado en /api/ai-token.
//
// `tenantId` es el tenant resuelto del request (x-tenant-id / Host). El token trae el
// tenant al que fue minteado; si no coincide, se rechaza (evita reusar un token válido
// de un tenant contra otro — ver agent-token.ts). Devuelve solo el codigocliente al caller.
export function authAgentRequest(req: Request, tenantId: string): { codigocliente: string } | null {
  const header = req.headers.get("authorization") ?? ""
  if (!header.startsWith("Bearer ")) return null
  const auth = verifyAgentToken(header.slice(7))
  if (!auth) return null
  if (auth.tenantId !== tenantId) {
    console.warn(
      `[agent-auth] token/tenant mismatch: token=${auth.tenantId} request=${tenantId} — rechazado`,
    )
    return null
  }
  return { codigocliente: auth.codigocliente }
}

// Auth para endpoints /api/agent/* con datos del TENANT (no de un cliente puntual),
// como el catálogo y las condiciones de pago. Acepta dos credenciales:
//  - crm_token de un cliente (flujo web/widget logueado), atado al tenant, o
//  - INTERNAL_SECRET server-to-server (flujo de canales: WhatsApp/IG, donde no hay
//    un cliente logueado y el bot consulta info general en nombre del tenant).
// Devuelve el codigocliente si vino por crm_token, o "internal" si vino por la llave.
//
// El path INTERNAL_SECRET NO chequea tenant del token (no hay token): es un secreto
// server-to-server de confianza y el tenant se resuelve del Host igual. El path crm_token
// sí exige que el tenant del token coincida con `tenantId`.
export function authAgentTenantRequest(req: Request, tenantId: string): { codigocliente: string } | null {
  const header = req.headers.get("authorization") ?? ""
  if (!header.startsWith("Bearer ")) return null
  const token = header.slice(7)

  const internal = process.env.INTERNAL_SECRET
  if (internal && secureCompare(token, internal)) return { codigocliente: "internal" }

  const auth = verifyAgentToken(token)
  if (!auth) return null
  if (auth.tenantId !== tenantId) {
    console.warn(
      `[agent-auth] token/tenant mismatch: token=${auth.tenantId} request=${tenantId} — rechazado`,
    )
    return null
  }
  return { codigocliente: auth.codigocliente }
}
