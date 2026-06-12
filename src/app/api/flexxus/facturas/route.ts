import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptions } from "@/lib/session"
import { getTenantConfig } from "@/lib/tenant-context"
import { getFacturas } from "@/lib/flexxus"
import type { SessionData } from "@/types"

export async function GET() {
  try {
    const [tenant, cookieStore] = await Promise.all([getTenantConfig(), cookies()])
    const session = await getIronSession<SessionData>(cookieStore, sessionOptions)

    if (!session.isLoggedIn || !session.codigocliente) {
      return Response.json({ error: "No autorizado" }, { status: 401 })
    }

    const facturas = await getFacturas(tenant, session.codigocliente)
    return Response.json(facturas)
  } catch (err) {
    console.error("flexxus/facturas error:", err)
    return Response.json({ error: "Error al obtener facturas" }, { status: 500 })
  }
}
