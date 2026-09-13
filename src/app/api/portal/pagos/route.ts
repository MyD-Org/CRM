import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptions } from "@/lib/session"
import { getTenantConfig } from "@/lib/tenant-context"
import { getPagosPage, PAGOS_PAGE_SIZE } from "@/lib/erp"
import type { SessionData } from "@/types"

// Páginas de pagos del portal. El cliente sale de la sesión, nunca de la query.
// Sin filtros: Alegra ignora date_afterOrNow en /payments (probado), y ofrecer un filtro
// que en realidad recorta solo lo cargado es peor que no ofrecerlo.

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    const cookieStore = await cookies()
    const session = await getIronSession<SessionData>(cookieStore, sessionOptions)
    if (!session.isLoggedIn || !session.codigocliente) {
      return Response.json({ error: "No autorizado" }, { status: 401 })
    }

    const start = Number(new URL(request.url).searchParams.get("start") ?? 0)
    if (!Number.isInteger(start) || start < 0) {
      return Response.json({ error: "Paginación inválida" }, { status: 400 })
    }

    const tenant = await getTenantConfig()
    const page = await getPagosPage(tenant, session.codigocliente, start, PAGOS_PAGE_SIZE)
    return Response.json(page, { headers: { "Cache-Control": "private, no-store" } })
  } catch (err) {
    console.error("portal/pagos error:", err)
    return Response.json({ error: "No pudimos cargar los pagos" }, { status: 502 })
  }
}
