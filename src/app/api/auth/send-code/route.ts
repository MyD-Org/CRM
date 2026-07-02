import { randomInt } from "node:crypto"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { otpSessionOptions } from "@/lib/session"
import { getTenantConfig } from "@/lib/tenant-context"
import type { OtpSessionData } from "@/types"

export async function POST(request: Request) {
  try {
    await getTenantConfig()
    const body = await request.json()
    const { identifier } = body as { identifier: string }

    if (!identifier || identifier.trim().length < 3) {
      return Response.json({ error: "Identificador inválido" }, { status: 400 })
    }

    // Código robusto: RNG criptográfico (no Math.random), 6 dígitos con padding.
    const otp = String(randomInt(0, 1_000_000)).padStart(6, "0")
    const otpExpiry = Date.now() + 10 * 60 * 1000

    const cookieStore = await cookies()
    // `attempts` (contador de intentos de verificación) no está en OtpSessionData;
    // lo extendemos localmente. Vive dentro de la cookie sellada de iron-session,
    // así que el cliente no puede resetearlo ni falsificarlo.
    const session = await getIronSession<OtpSessionData & { attempts?: number }>(
      cookieStore,
      otpSessionOptions,
    )
    session.identifier = identifier.trim()
    session.otp = otp
    session.otpExpiry = otpExpiry
    session.attempts = 0 // reinicia el contador al emitir un código nuevo
    await session.save()

    // No logueamos el OTP en claro. En dev lo devolvemos como devCode para QA
    // (mismo patrón que ai-api /admin/auth/request-code).
    // RIESGO ABIERTO: este endpoint no tiene canal de entrega real (email/SMS);
    // fuera de dev el código no llega a ninguna parte. Ver reporte.
    const isProd = process.env.NODE_ENV === "production"
    return Response.json({
      success: true,
      message: "Código enviado",
      ...(isProd ? {} : { devCode: otp }),
    })
  } catch (err) {
    console.error("send-code error:", err)
    return Response.json({ error: "Error interno del servidor" }, { status: 500 })
  }
}
