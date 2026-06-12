import { verifyAgentToken } from "@/lib/agent-token"

// Auth compartida de los endpoints /api/agent/*: Bearer token minteado en /api/ai-token.
export function authAgentRequest(req: Request): { codigocliente: string } | null {
  const header = req.headers.get("authorization") ?? ""
  if (!header.startsWith("Bearer ")) return null
  return verifyAgentToken(header.slice(7))
}
