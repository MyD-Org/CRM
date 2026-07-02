import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { listConversations, archiveConversation } from "@/lib/inbox-api"
import { bearerMatches } from "@/lib/secure-compare"

const HOURS_24 = 24 * 60 * 60 * 1000

// Auto-cierre: finaliza (status='closed', vuelve a bot) las conversaciones donde el cliente
// no escribió en las últimas 24hs. A esa altura la ventana de WA ya está cerrada y la
// conversación cayó del inbox activo; cerrarla evita sesiones colgadas y deja la próxima
// interacción arrancar limpia. Reemplaza al viejo "auto-return-bot". Ver ADR 0006.
async function autoCloseStale(aiApiUrl: string, aiTenantId: string): Promise<number> {
  const conversations = await listConversations(aiApiUrl, aiTenantId)
  const stale = conversations.filter((c) => {
    if (c.status === "closed") return false
    if (!c.last_inbound_at) return false // sin actividad conocida → no tocar
    return Date.now() - new Date(c.last_inbound_at).getTime() > HOURS_24
  })
  await Promise.allSettled(stale.map((c) => archiveConversation(aiApiUrl, aiTenantId, c.id)))
  return stale.length
}

export async function POST(req: Request) {
  if (!bearerMatches(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  const allTenants = await getDb()
    .select({ aiApiUrl: tenants.aiApiUrl, aiTenantId: tenants.aiTenantId })
    .from(tenants)

  const results = await Promise.allSettled(
    allTenants
      .filter((t) => t.aiApiUrl && t.aiTenantId)
      .map((t) => autoCloseStale(t.aiApiUrl, t.aiTenantId)),
  )

  const closed = results.reduce((sum, r) => sum + (r.status === "fulfilled" ? r.value : 0), 0)
  return Response.json({ closed })
}

export const GET = POST
