import { createHmac, timingSafeEqual } from "crypto"
import { SESSION_SECRET } from "@/lib/session-secret"

// Tokens firmados (HMAC-SHA256) con los que las tools del agente de ai-api
// consultan los endpoints /api/agent/* en nombre del cliente logueado.
//
// El payload ata el token a UN tenant (`t`): ai-api solo transporta el token y lo
// devuelve en cada tool call, pero el tenant del request se resuelve del Host
// (subdominio → x-tenant-id). Sin `t` en el payload, un token válido de un cliente
// del tenant A podría reusarse contra el Host del tenant B (mismo SESSION_SECRET
// global). Con `t`, cada /api/agent/* exige que el tenant del token coincida con el
// tenant resuelto del request.
//
// TODO(seguridad): SESSION_SECRET hoy firma esto Y es el password de iron-session.
// Idealmente separar la clave HMAC del `crm_token` (rotación independiente). Fuera
// de alcance de este pase.

const TTL_MS = 60 * 60 * 1000 // 1h, igual que la sesión del widget

function sign(payload: string): string {
  return createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url")
}

export function mintAgentToken(codigocliente: string, tenantId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ c: codigocliente, t: tenantId, e: Date.now() + TTL_MS }),
  ).toString("base64url")
  return `${payload}.${sign(payload)}`
}

export function verifyAgentToken(token: string): { codigocliente: string; tenantId: string } | null {
  const [payload, signature] = token.split(".")
  if (!payload || !signature) return null

  const expected = sign(payload)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString())
    if (
      typeof data.c !== "string" ||
      typeof data.t !== "string" ||
      typeof data.e !== "number" ||
      Date.now() > data.e
    ) {
      return null
    }
    return { codigocliente: data.c, tenantId: data.t }
  } catch {
    return null
  }
}
