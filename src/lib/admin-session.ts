import type { SessionOptions } from "iron-session"

export interface AdminSessionData {
  userId: string
  name: string
  email: string
  role: "operator" | "superadmin"
  tenantId: string
}

export const adminSessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET ?? "development-secret-change-in-production-32chars",
  cookieName: "admin-session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
  },
}
