import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptions } from "@/lib/session"
import type { SessionData } from "@/types"

export async function POST() {
  try {
    const cookieStore = await cookies()
    const session = await getIronSession<SessionData>(cookieStore, sessionOptions)
    session.destroy()
    return Response.json({ success: true })
  } catch (err) {
    console.error("logout error:", err)
    return Response.json({ error: "Error interno del servidor" }, { status: 500 })
  }
}
