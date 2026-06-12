import { createHmac, timingSafeEqual } from "crypto"

// Tokens firmados (HMAC-SHA256) con los que las tools del agente de ai-api
// consultan los endpoints /api/agent/* en nombre del cliente logueado.

const SECRET = process.env.SESSION_SECRET ?? ""
const TTL_MS = 60 * 60 * 1000 // 1h, igual que la sesión del widget

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("base64url")
}

export function mintAgentToken(codigocliente: string): string {
  const payload = Buffer.from(JSON.stringify({ c: codigocliente, e: Date.now() + TTL_MS })).toString("base64url")
  return `${payload}.${sign(payload)}`
}

export function verifyAgentToken(token: string): { codigocliente: string } | null {
  const [payload, signature] = token.split(".")
  if (!payload || !signature) return null

  const expected = sign(payload)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString())
    if (typeof data.c !== "string" || typeof data.e !== "number" || Date.now() > data.e) return null
    return { codigocliente: data.c }
  } catch {
    return null
  }
}
