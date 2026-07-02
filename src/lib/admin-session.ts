import type { SessionOptions } from "iron-session"
import { SESSION_SECRET } from "@/lib/session-secret"

export interface AdminSessionData {
  userId: string
  name: string
  email: string
  role: "operator" | "superadmin"
  tenantId: string
}

export const adminSessionOptions: SessionOptions = {
  password: SESSION_SECRET,
  cookieName: "admin-session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
  },
}
