import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptions } from "@/lib/session"
import { getPagos } from "@/lib/flexxus"
import type { SessionData } from "@/types"

export async function GET() {
  try {
    const cookieStore = await cookies()
    const session = await getIronSession<SessionData>(cookieStore, sessionOptions)

    if (!session.isLoggedIn || !session.codigocliente) {
      return Response.json({ error: "No autorizado" }, { status: 401 })
    }

    const pagos = await getPagos(session.codigocliente)
    return Response.json(pagos)
  } catch (err) {
    console.error("flexxus/pagos error:", err)
    return Response.json({ error: "Error al obtener pagos" }, { status: 500 })
  }
}
