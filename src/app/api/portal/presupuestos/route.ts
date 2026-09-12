import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptions } from "@/lib/session"
import { getTenantConfig } from "@/lib/tenant-context"
import { getPresupuestosPage, PRESUPUESTOS_PAGE_SIZE } from "@/lib/erp"
import type { SessionData } from "@/types"

// Páginas de presupuestos del portal. El cliente sale de la sesión, nunca de la query.
//
// Filtros que Alegra sí resuelve (probado): estado → `status=billed|unbilled`, y fecha de
// emisión → date_afterOrNow/date_beforeOrNow. "Vigente" y "vencido" NO se ofrecen por
// separado: los dos son `unbilled` y los separa el vencimiento, que Alegra no filtra.

export const dynamic = "force-dynamic"

const ESTADO_A_STATUS = { aceptado: "billed", "sin-aceptar": "unbilled" } as const

export async function GET(request: Request) {
  try {
    const cookieStore = await cookies()
    const session = await getIronSession<SessionData>(cookieStore, sessionOptions)
    if (!session.isLoggedIn || !session.codigocliente) {
      return Response.json({ error: "No autorizado" }, { status: 401 })
    }

    const params = new URL(request.url).searchParams
    const start = Number(params.get("start") ?? 0)
    if (!Number.isInteger(start) || start < 0) {
      return Response.json({ error: "Paginación inválida" }, { status: 400 })
    }

    const estado = params.get("estado")
    const status = estado && estado in ESTADO_A_STATUS ? ESTADO_A_STATUS[estado as keyof typeof ESTADO_A_STATUS] : undefined
    const dateFrom = params.get("desde") ?? undefined
    const dateTo = params.get("hasta") ?? undefined
    for (const fecha of [dateFrom, dateTo]) {
      if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        return Response.json({ error: "Fecha inválida" }, { status: 400 })
      }
    }

    const tenant = await getTenantConfig()
    const page = await getPresupuestosPage(tenant, session.codigocliente, start, PRESUPUESTOS_PAGE_SIZE, {
      status,
      dateFrom,
      dateTo,
    })
    return Response.json(page, { headers: { "Cache-Control": "private, no-store" } })
  } catch (err) {
    console.error("portal/presupuestos error:", err)
    return Response.json({ error: "No pudimos cargar los presupuestos" }, { status: 502 })
  }
}
