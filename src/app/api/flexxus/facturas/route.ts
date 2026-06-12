import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptions } from "@/lib/session"
import { getFacturas } from "@/lib/flexxus"
import type { SessionData } from "@/types"

export async function GET() {
  try {
    const cookieStore = await cookies()
    const session = await getIronSession<SessionData>(cookieStore, sessionOptions)

    if (!session.isLoggedIn || !session.codigocliente) {
      return Response.json({ error: "No autorizado" }, { status: 401 })
    }

    const facturas = await getFacturas(session.codigocliente)
    return Response.json(facturas)
  } catch (err) {
    console.error("flexxus/facturas error:", err)
    return Response.json({ error: "Error al obtener facturas" }, { status: 500 })
  }
}
