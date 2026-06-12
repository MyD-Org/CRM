import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptions } from "@/lib/session"
import { getTenantConfig } from "@/lib/tenant-context"
import { getPresupuestos } from "@/lib/flexxus"
import type { SessionData } from "@/types"

export async function GET() {
  try {
    const [tenant, cookieStore] = await Promise.all([getTenantConfig(), cookies()])
    const session = await getIronSession<SessionData>(cookieStore, sessionOptions)

    if (!session.isLoggedIn || !session.codigocliente) {
      return Response.json({ error: "No autorizado" }, { status: 401 })
    }

    const presupuestos = await getPresupuestos(tenant, session.codigocliente)
    return Response.json(presupuestos)
  } catch (err) {
    console.error("flexxus/presupuestos error:", err)
    return Response.json({ error: "Error al obtener presupuestos" }, { status: 500 })
  }
}
