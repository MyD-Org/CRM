import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { listConversations, setMode } from "@/lib/inbox-api"

const HOURS_24 = 24 * 60 * 60 * 1000

// Devuelve al bot las conversaciones en modo 'human' donde el cliente no escribió
// en las últimas 24hs (la ventana de WA también está cerrada a esa altura).
async function autoReturnConversations(aiApiUrl: string, aiTenantId: string): Promise<number> {
  const conversations = await listConversations(aiApiUrl, aiTenantId)
  const stale = conversations.filter((c) => {
    if (c.mode !== "human") return false
    if (!c.last_inbound_at) return false // sin actividad conocida → no tocar
    return Date.now() - new Date(c.last_inbound_at).getTime() > HOURS_24
  })
  await Promise.allSettled(stale.map((c) => setMode(aiApiUrl, aiTenantId, c.id, "bot")))
  return stale.length
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization")
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  const allTenants = await getDb()
    .select({ aiApiUrl: tenants.aiApiUrl, aiTenantId: tenants.aiTenantId })
    .from(tenants)

  const results = await Promise.allSettled(
    allTenants
      .filter((t) => t.aiApiUrl && t.aiTenantId)
      .map((t) => autoReturnConversations(t.aiApiUrl, t.aiTenantId)),
  )

  const returned = results.reduce((sum, r) => sum + (r.status === "fulfilled" ? r.value : 0), 0)
  return Response.json({ returned })
}

export const GET = POST
