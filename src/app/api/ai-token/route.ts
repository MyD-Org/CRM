import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptions } from "@/lib/session"
import { getTenantConfig } from "@/lib/tenant-context"
import { mintAgentToken } from "@/lib/agent-token"
import type { SessionData } from "@/types"

export async function POST() {
  try {
    const [tenant, cookieStore] = await Promise.all([getTenantConfig(), cookies()])
    const session = await getIronSession<SessionData>(cookieStore, sessionOptions)

    if (!session.isLoggedIn || !session.codigocliente) {
      return Response.json({ error: "No autenticado" }, { status: 401 })
    }

    if (!tenant.aiApiBaseUrl || !tenant.aiApiKey) {
      return Response.json({ error: "Chat no configurado" }, { status: 503 })
    }

    const res = await fetch(`${tenant.aiApiBaseUrl}/v1/end-user-sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tenant.aiApiKey}`,
      },
      body: JSON.stringify({
        external_id: session.codigocliente,
        display_name: session.razonsocial,
        // Token con el que las tools del agente consultan /api/agent/* del CRM
        // en nombre del usuario logueado.
        claims: { crm_token: mintAgentToken(session.codigocliente, tenant.id) },
      }),
    })

    if (!res.ok) {
      console.error("ai-token: end-user-sessions failed:", res.status, await res.text())
      return Response.json({ error: "No se pudo iniciar el chat" }, { status: 502 })
    }

    const data = await res.json()
    return Response.json({ token: data.token })
  } catch (err) {
    console.error("ai-token error:", err)
    return Response.json({ error: "Error interno del servidor" }, { status: 500 })
  }
}
