import { verifyAgentToken } from "@/lib/agent-token"

// Auth compartida de los endpoints /api/agent/*: Bearer token minteado en /api/ai-token.
export function authAgentRequest(req: Request): { codigocliente: string } | null {
  const header = req.headers.get("authorization") ?? ""
  if (!header.startsWith("Bearer ")) return null
  return verifyAgentToken(header.slice(7))
}

// Auth para endpoints /api/agent/* con datos del TENANT (no de un cliente puntual),
// como el catálogo y las condiciones de pago. Acepta dos credenciales:
//  - crm_token de un cliente (flujo web/widget logueado), o
//  - INTERNAL_SECRET server-to-server (flujo de canales: WhatsApp/IG, donde no hay
//    un cliente logueado y el bot consulta info general en nombre del tenant).
// Devuelve el codigocliente si vino por crm_token, o "internal" si vino por la llave.
export function authAgentTenantRequest(req: Request): { codigocliente: string } | null {
  const header = req.headers.get("authorization") ?? ""
  if (!header.startsWith("Bearer ")) return null
  const token = header.slice(7)

  const internal = process.env.INTERNAL_SECRET
  if (internal && token === internal) return { codigocliente: "internal" }

  return verifyAgentToken(token)
}
