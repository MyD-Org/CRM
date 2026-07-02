import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptions, otpSessionOptions } from "@/lib/session"
import { getTenantConfig } from "@/lib/tenant-context"
import { getCliente } from "@/lib/flexxus"
import type { SessionData, OtpSessionData } from "@/types"

// Intentos de verificación permitidos por código antes de invalidarlo.
const MAX_OTP_ATTEMPTS = 5

export async function POST(request: Request) {
  try {
    const tenant = await getTenantConfig()
    const body = await request.json()
    const { code, redirectTo } = body as { code: string; redirectTo?: string }

    if (!code || code.length !== 6) {
      return Response.json({ error: "Código inválido" }, { status: 400 })
    }

    const cookieStore = await cookies()

    // `attempts` no está en OtpSessionData; se extiende localmente. Vive en la cookie
    // sellada, por lo que el cliente no puede resetearlo para saltear el límite.
    const otpSession = await getIronSession<OtpSessionData & { attempts?: number }>(
      cookieStore,
      otpSessionOptions,
    )

    if (!otpSession.otp || !otpSession.otpExpiry || !otpSession.identifier) {
      return Response.json({ error: "Sesión de verificación expirada. Solicitá un nuevo código." }, { status: 400 })
    }

    if (Date.now() > otpSession.otpExpiry) {
      otpSession.destroy()
      return Response.json({ error: "El código ha expirado. Solicitá uno nuevo." }, { status: 400 })
    }

    if (otpSession.otp !== code) {
      // Límite de intentos: tras MAX_OTP_ATTEMPTS fallos invalidamos el código.
      const attempts = (otpSession.attempts ?? 0) + 1
      if (attempts >= MAX_OTP_ATTEMPTS) {
        otpSession.destroy()
        return Response.json(
          { error: "Demasiados intentos fallidos. Solicitá un nuevo código." },
          { status: 429 },
        )
      }
      otpSession.attempts = attempts
      await otpSession.save()
      return Response.json({ error: "Código incorrecto" }, { status: 400 })
    }

    const clienteData = await getCliente(tenant, otpSession.identifier)

    const session = await getIronSession<SessionData>(cookieStore, sessionOptions)
    session.isLoggedIn = true
    session.codigocliente = clienteData.codigocliente
    session.razonsocial = clienteData.razonsocial
    session.cuit = clienteData.cuit
    session.email = otpSession.identifier
    session.tipoCuenta = clienteData.tipoCuenta
    await session.save()

    otpSession.destroy()

    // redirectTo viene de la tienda; solo se acepta si el origen coincide con SHOP_REDIRECT_ORIGIN
    const safeRedirect = (() => {
      if (!redirectTo) return "/portal/dashboard"
      const allowed = process.env.SHOP_REDIRECT_ORIGIN
      if (!allowed) return "/portal/dashboard"
      try {
        const url = new URL(redirectTo)
        if (url.origin === allowed) return redirectTo
      } catch {}
      return "/portal/dashboard"
    })()
    return Response.json({ success: true, redirect: safeRedirect })
  } catch (err) {
    console.error("verify-code error:", err)
    return Response.json({ error: "Error interno del servidor" }, { status: 500 })
  }
}
