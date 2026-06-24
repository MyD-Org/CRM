import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

export async function POST() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  session.destroy()
  return NextResponse.json({ ok: true })
}
