import { Resend } from "resend"
import type { TenantConfig } from "@/lib/tenants"

// Envío de mail transaccional del tenant. Lo usan el gestor de cobranza
// (lib/notifications.ts) y el código de acceso al portal (/api/auth/send-code).
//
// El remitente sale de `tenant.resendFrom`: su DOMINIO tiene que estar verificado en
// Resend. Un from de un dominio no verificado no falla en silencio — Resend devuelve
// error y acá se propaga como excepción.

/**
 * Manda un mail. Sin `RESEND_API_KEY` es dry-run: loguea y no envía, para que dev/local
 * funcione sin credenciales.
 *
 * `text` es la alternativa en texto plano. Vale la pena mandarla siempre: mejora la
 * entregabilidad (un mail solo-HTML puntúa peor en los filtros de spam) y es la parte
 * que miran los detectores de códigos de verificación del celular.
 *
 * @returns true si salió de verdad, false si fue dry-run.
 * @throws si Resend rechaza el envío (from no verificado, destinatario inválido, …).
 */
export async function sendEmail(
  tenant: TenantConfig,
  to: string,
  subject: string,
  html: string,
  text?: string,
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.log(`[email dry-run] to=${to} subject="${subject}"`)
    return false
  }
  const resend = new Resend(apiKey)
  const { error } = await resend.emails.send({
    from: tenant.resendFrom,
    to,
    subject,
    html,
    ...(text ? { text } : {}),
  })
  if (error) throw new Error(error.message)
  return true
}

/** `dalila@live.com` → `da***@live.com`. Para decirle a quién se le mandó el código sin exponerlo entero. */
export function maskEmail(email: string): string {
  const [user = "", domain = ""] = email.split("@")
  if (!domain) return "***"
  const head = user.slice(0, 2)
  return `${head}${"*".repeat(Math.max(3, user.length - head.length))}@${domain}`
}
