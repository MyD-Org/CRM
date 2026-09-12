import { SessionOptions } from "iron-session"
import type { SessionData, OtpSessionData } from "@/types"
import { SESSION_SECRET } from "@/lib/session-secret"

export type { SessionData, OtpSessionData }

const baseCookieOptions = {
  secure: process.env.NODE_ENV === "production",
  httpOnly: true,
  sameSite: "lax",
} as const

/**
 * Dominio para la cookie de sesión del portal, o `undefined` para cookie host-only.
 *
 * `COOKIE_DOMAIN` existe para que la tienda comparta la sesión con el CRM bajo un
 * mismo dominio raíz (`centralled.com.ar` + `crm.centralled.com.ar`). Pero la
 * plataforma es multi-tenant sobre dominios raíz DISTINTOS: en `avantec.tevro.com.ar`
 * un `Domain=.centralled.com.ar` no aplica, y el navegador **descarta el Set-Cookie
 * sin avisar** — el login parece andar (verify-code devuelve success) y la siguiente
 * página rebota al login porque no hay sesión.
 *
 * Por eso el dominio solo se aplica cuando el host del request está DENTRO de él.
 * Para cualquier otro tenant la cookie queda host-only, que es lo correcto.
 */
export function sessionCookieDomain(host?: string | null): string | undefined {
  const configured = process.env.COOKIE_DOMAIN
  if (!configured || !host) return undefined

  const normalized = host.split(",")[0].trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "")
  const base = configured.replace(/^\./, "").toLowerCase()
  if (normalized === base || normalized.endsWith(`.${base}`)) return configured
  return undefined
}

/**
 * Opciones de la cookie de sesión para el host del request. Usala en todo lo que
 * ESCRIBA la cookie (login, logout): ahí el `domain` decide si el navegador la acepta.
 * Para leer alcanza con `sessionOptions` — el atributo `domain` no participa de la
 * lectura, el navegador manda toda cookie cuyo dominio matchee y iron-session la
 * busca por nombre.
 */
export function sessionOptionsForHost(host?: string | null): SessionOptions {
  const domain = sessionCookieDomain(host)
  return {
    password: SESSION_SECRET,
    cookieName: "portal-session",
    cookieOptions: { ...baseCookieOptions, ...(domain ? { domain } : {}) },
  }
}

export const sessionOptions: SessionOptions = {
  password: SESSION_SECRET,
  cookieName: "portal-session",
  cookieOptions: { ...baseCookieOptions },
}

export const otpSessionOptions: SessionOptions = {
  password: SESSION_SECRET,
  cookieName: "portal-otp",
  cookieOptions: {
    ...baseCookieOptions,
    maxAge: 60 * 10,
  },
}
