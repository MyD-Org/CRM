import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptions } from "@/lib/session"
import { getCliente } from "@/lib/flexxus"
import type { SessionData } from "@/types"

export async function GET() {
  try {
    const cookieStore = await cookies()
    const session = await getIronSession<SessionData>(cookieStore, sessionOptions)

    if (!session.isLoggedIn || !session.codigocliente) {
      return Response.json({ error: "No autorizado" }, { status: 401 })
    }

    const cliente = await getCliente(session.codigocliente)
    return Response.json(cliente)
  } catch (err) {
    console.error("flexxus/cliente error:", err)
    return Response.json({ error: "Error al obtener datos del cliente" }, { status: 500 })
  }
}
