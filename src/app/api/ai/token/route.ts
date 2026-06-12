import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptions } from "@/lib/session"
import type { SessionData } from "@/types"

// Mintea el JWT de sesión de usuario final para el widget. La API key del tenant
// vive solo en el server (AI_API_KEY); el browser nunca la ve.
export async function POST() {
  const cookieStore = await cookies()
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions)

  if (!session.isLoggedIn || !session.codigocliente) {
    return Response.json({ error: "No autorizado" }, { status: 401 })
  }

  const apiUrl = process.env.AI_API_URL
  const apiKey = process.env.AI_API_KEY
  if (!apiUrl || !apiKey) {
    console.error("ai/token: faltan AI_API_URL o AI_API_KEY")
    return Response.json({ error: "Asistente no configurado" }, { status: 500 })
  }

  try {
    const res = await fetch(`${apiUrl}/v1/end-user-sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        external_id: String(session.codigocliente),
        display_name: session.razonsocial ?? undefined,
        claims: { codigocliente: String(session.codigocliente) },
      }),
    })
    if (!res.ok) {
      console.error("ai/token: end-user-sessions respondió", res.status)
      return Response.json({ error: "No se pudo iniciar el asistente" }, { status: 502 })
    }
    const data = (await res.json()) as { token: string }
    return Response.json({ token: data.token })
  } catch (err) {
    console.error("ai/token error:", err)
    return Response.json({ error: "No se pudo iniciar el asistente" }, { status: 502 })
  }
}
