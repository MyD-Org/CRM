import { NextRequest, NextResponse } from "next/server"
import { isKnownTenantId, resolveTenantIdFromHost } from "@/lib/tenants"
import { checkSiteGate } from "@/lib/site-gate"

export async function proxy(req: NextRequest) {
  const override = process.env.TENANT_OVERRIDE
  const tenantId = override ?? resolveTenantIdFromHost(req.headers.get("host") ?? "")

  // La config completa del tenant se carga desde la DB en getTenantConfig (server runtime).
  if (!isKnownTenantId(tenantId)) {
    return new NextResponse(`Tenant "${tenantId}" not found`, { status: 404 })
  }

  // Gate temporal mientras el CRM no esta listo para produccion. Solo tapa
  // paginas: /api/* ya tiene su propia auth (Bearer, iron-session, CRON_SECRET)
  // y la usan integraciones externas (bots de WhatsApp/IG, cron) que no van
  // a mandar la cookie del gate.
  if (!req.nextUrl.pathname.startsWith("/api/")) {
    const gated = await checkSiteGate(req)
    if (gated) return gated
  }

  const res = NextResponse.next()
  res.headers.set("x-tenant-id", tenantId)
  return res
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|logos/).*)"],
}
