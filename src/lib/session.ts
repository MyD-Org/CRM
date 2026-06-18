import { SessionOptions } from "iron-session"
import type { SessionData, OtpSessionData } from "@/types"

export type { SessionData, OtpSessionData }

export const sessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET ?? "development-secret-change-in-production-32chars",
  cookieName: "portal-session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    // Dominio raiz compartido para que la tienda pueda leer la sesion
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  },
}

export const otpSessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET ?? "development-secret-change-in-production-32chars",
  cookieName: "portal-otp",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 10,
  },
}
