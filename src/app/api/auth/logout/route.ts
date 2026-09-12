import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptionsForHost } from "@/lib/session"
import type { SessionData } from "@/types"

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies()
    // Mismo domain que al sellarla: si no coincide, el navegador no la borra.
    const session = await getIronSession<SessionData>(
      cookieStore,
      sessionOptionsForHost(request.headers.get("host")),
    )
    session.destroy()
    return Response.json({ success: true })
  } catch (err) {
    console.error("logout error:", err)
    return Response.json({ error: "Error interno del servidor" }, { status: 500 })
  }
}
