import { SessionOptions } from "iron-session"
import type { SessionData, OtpSessionData } from "@/types"

export type { SessionData, OtpSessionData }

export const sessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET ?? "development-secret-change-in-production-32chars",
  cookieName: "central-led-session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
  },
}

export const otpSessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET ?? "development-secret-change-in-production-32chars",
  cookieName: "central-led-otp",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 10, // 10 minutes
  },
}
