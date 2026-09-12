import { randomInt } from "node:crypto"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { otpSessionOptions } from "@/lib/session"
import { getTenantConfig } from "@/lib/tenant-context"
import { getClienteByIdentifier } from "@/lib/erp"
import { sendEmail, maskEmail } from "@/lib/email"
import type { TenantConfig } from "@/lib/tenants"
import type { OtpSessionData } from "@/types"

// Código de acceso al portal del cliente. El identificador (CUIT o email) se resuelve
// contra Alegra y el código se manda SIEMPRE al email que el contacto tiene cargado
// ahí — no al que se tipeó: el mail del ERP es el dato autoritativo, y así tipear el
// email de otro no sirve para recibir su código.

const OTP_TTL_MS = 10 * 60 * 1000

// ── Límite de envíos ────────────────────────────────────────────────────────
// Este endpoint es anónimo y dispara un mail: sin límite es un generador de spam
// gratis contra los clientes del tenant. Ventana deslizante por (tenant, identificador),
// mismo patrón que el login del admin.
// CAVEAT (igual que allá): el Map es por proceso, no se comparte entre instancias de
// Vercel y se reinicia con el deploy. Alcanza para el volumen del portal.
const MAX_SENDS = 5
const SEND_WINDOW_MS = 15 * 60 * 1000

type SendBucket = { count: number; firstAt: number }
const sendAttempts = new Map<string, SendBucket>()

function sweep(now: number) {
  for (const [key, b] of sendAttempts) {
    if (now - b.firstAt > SEND_WINDOW_MS) sendAttempts.delete(key)
  }
}

/** Consume una unidad de cuota. `false` = límite alcanzado. */
function takeSendSlot(key: string, now: number): boolean {
  let b = sendAttempts.get(key)
  if (!b || now - b.firstAt > SEND_WINDOW_MS) b = { count: 0, firstAt: now }
  if (b.count >= MAX_SENDS) {
    sendAttempts.set(key, b)
    return false
  }
  b.count += 1
  sendAttempts.set(key, b)
  return true
}

function buildOtpEmail(tenant: TenantConfig, razonsocial: string, otp: string) {
  return {
    subject: `${tenant.name} — Tu código de acceso: ${otp}`,
    html: `
  <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#111827">
    <h2 style="font-size:18px">${tenant.name}</h2>
    <p>Hola ${razonsocial},</p>
    <p>Este es tu código para entrar al portal de clientes:</p>
    <p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:24px 0">${otp}</p>
    <p style="color:#6b7280;font-size:14px">Vence en 10 minutos y sirve una sola vez.</p>
    <p style="color:#6b7280;font-size:12px">Si no pediste este código, ignorá este mensaje: sin él nadie puede entrar a tu cuenta.</p>
  </div>`,
  }
}

export async function POST(request: Request) {
  try {
    const tenant = await getTenantConfig()
    const body = await request.json()
    const { identifier: raw } = body as { identifier: string }

    if (!raw || raw.trim().length < 3) {
      return Response.json({ error: "Identificador inválido" }, { status: 400 })
    }
    const identifier = raw.trim()

    const now = Date.now()
    sweep(now)
    if (!takeSendSlot(`${tenant.id}:${identifier.toLowerCase()}`, now)) {
      return Response.json(
        { error: "Pediste demasiados códigos. Esperá unos minutos." },
        { status: 429 },
      )
    }

    // La cuenta se resuelve ACÁ y no recién al verificar: sin esto mandaríamos un mail
    // (o ninguno) y el usuario se enteraría de que no existe después de tipear 6 dígitos.
    const cliente = await getClienteByIdentifier(tenant, identifier)
    if (!cliente) {
      return Response.json(
        { error: "No encontramos una cuenta con ese CUIT o email. Contactate con atención al cliente." },
        { status: 404 },
      )
    }
    if (!cliente.email) {
      return Response.json(
        { error: "Tu cuenta no tiene un email cargado. Contactate con atención al cliente." },
        { status: 409 },
      )
    }

    // Código robusto: RNG criptográfico (no Math.random), 6 dígitos con padding.
    const otp = String(randomInt(0, 1_000_000)).padStart(6, "0")

    const { subject, html } = buildOtpEmail(tenant, cliente.razonsocial, otp)
    let delivered: boolean
    try {
      delivered = await sendEmail(tenant, cliente.email, subject, html)
    } catch (err) {
      // No se guarda la sesión OTP: un código que no llegó no debe dejar al usuario
      // esperando en la pantalla de los 6 dígitos.
      console.error("send-code: falló el envío del email:", err)
      return Response.json(
        { error: "No pudimos enviar el código. Intentá de nuevo en unos minutos." },
        { status: 502 },
      )
    }

    const cookieStore = await cookies()
    // `attempts` (contador de intentos de verificación) no está en OtpSessionData;
    // lo extendemos localmente. Vive dentro de la cookie sellada de iron-session,
    // así que el cliente no puede resetearlo ni falsificarlo.
    const session = await getIronSession<OtpSessionData & { attempts?: number }>(
      cookieStore,
      otpSessionOptions,
    )
    session.identifier = identifier
    session.otp = otp
    session.otpExpiry = Date.now() + OTP_TTL_MS
    session.attempts = 0 // reinicia el contador al emitir un código nuevo
    await session.save()

    // No logueamos el OTP en claro. Fuera de producción se devuelve como devCode para QA
    // (mismo patrón que ai-api /admin/auth/request-code): sin RESEND_API_KEY el envío es
    // dry-run y este es el único modo de completar el login en local.
    const isProd = process.env.NODE_ENV === "production"
    return Response.json({
      success: true,
      message: "Código enviado",
      sentTo: maskEmail(cliente.email),
      ...(isProd ? {} : { devCode: otp, delivered }),
    })
  } catch (err) {
    console.error("send-code error:", err)
    return Response.json({ error: "Error interno del servidor" }, { status: 500 })
  }
}
