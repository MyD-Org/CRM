import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { otpSessionOptions } from "@/lib/session"
import { getTenantConfig } from "@/lib/tenant-context"
import type { OtpSessionData } from "@/types"

export async function POST(request: Request) {
  try {
    const tenant = await getTenantConfig()
    const body = await request.json()
    const { identifier } = body as { identifier: string }

    if (!identifier || identifier.trim().length < 3) {
      return Response.json({ error: "Identificador inválido" }, { status: 400 })
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString()
    const otpExpiry = Date.now() + 10 * 60 * 1000

    const cookieStore = await cookies()
    const session = await getIronSession<OtpSessionData>(cookieStore, otpSessionOptions)
    session.identifier = identifier.trim()
    session.otp = otp
    session.otpExpiry = otpExpiry
    await session.save()

    console.log(`[${tenant.name} OTP] Para ${identifier}: ${otp} (válido 10 min)`)

    return Response.json({ success: true, message: "Código enviado" })
  } catch (err) {
    console.error("send-code error:", err)
    return Response.json({ error: "Error interno del servidor" }, { status: 500 })
  }
}
