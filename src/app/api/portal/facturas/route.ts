import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptions } from "@/lib/session"
import { getTenantConfig } from "@/lib/tenant-context"
import { getFacturasPage, FACTURAS_PAGE_SIZE } from "@/lib/erp"
import type { SessionData } from "@/types"

// Páginas de facturas para el "Cargar más" del portal. El cliente sale de la sesión, nunca
// de la query: pedir las facturas de otro no es cuestión de cambiar un parámetro.

export const dynamic = "force-dynamic"

// Los estados del portal contra los de Alegra. "pendiente" y "vencida" son las dos caras
// de `open`: la diferencia la hace el vencimiento, que Alegra NO sabe filtrar, así que ese
// corte se hace acá con las filas ya traídas.
const ESTADO_A_STATUS: Record<string, string> = {
  pendiente: "open",
  vencida: "open",
  pagada: "closed",
  anulada: "void",
}

export async function GET(request: Request) {
  try {
    const cookieStore = await cookies()
    const session = await getIronSession<SessionData>(cookieStore, sessionOptions)
    if (!session.isLoggedIn || !session.codigocliente) {
      return Response.json({ error: "No autorizado" }, { status: 401 })
    }

    const params = new URL(request.url).searchParams
    const start = Number(params.get("start") ?? 0)
    // Tope duro en el tamaño de página: `limit` no es una vía para pedir el historial
    // entero de una y volver al problema que esto resuelve.
    if (!Number.isInteger(start) || start < 0) {
      return Response.json({ error: "Paginación inválida" }, { status: 400 })
    }

    // Los filtros de estado y fecha los resuelve Alegra, no el navegador: sin esto,
    // filtrar "Pagadas" solo miraría las 30 filas ya cargadas.
    const estado = params.get("estado")
    const status = estado && estado in ESTADO_A_STATUS ? ESTADO_A_STATUS[estado] : undefined
    const dateFrom = params.get("desde") ?? undefined
    const dateTo = params.get("hasta") ?? undefined
    for (const fecha of [dateFrom, dateTo]) {
      if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        return Response.json({ error: "Fecha inválida" }, { status: 400 })
      }
    }

    const tenant = await getTenantConfig()
    const page = await getFacturasPage(tenant, session.codigocliente, start, FACTURAS_PAGE_SIZE, {
      status,
      dateFrom,
      dateTo,
    })

    return Response.json(page, { headers: { "Cache-Control": "private, no-store" } })
  } catch (err) {
    console.error("portal/facturas error:", err)
    return Response.json({ error: "No pudimos cargar más facturas" }, { status: 502 })
  }
}
