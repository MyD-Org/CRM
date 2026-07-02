import { runNotifications } from "@/lib/notifications"
import { bearerMatches } from "@/lib/secure-compare"

// Disparo manual — uso interno hasta que exista el panel de administración.
// Acepta filtros opcionales: { tenantId, codigocliente }
export async function POST(req: Request) {
  if (!bearerMatches(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const { tenantId, codigocliente } = body as { tenantId?: string; codigocliente?: string }
    const result = await runNotifications({ tenantId, codigocliente })
    return Response.json(result)
  } catch (err) {
    console.error("notifications/send error:", err)
    return Response.json({ error: "internal_error" }, { status: 500 })
  }
}
