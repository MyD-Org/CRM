import { NextRequest, NextResponse } from "next/server"
import { isKnownTenantId } from "@/lib/tenants"

export function middleware(req: NextRequest) {
  const override = process.env.TENANT_OVERRIDE
  const tenantId = override ?? req.headers.get("host")?.split(".")[0] ?? ""

  // Edge runtime: solo valida que el ID esté en TENANT_IDS; la config completa
  // se carga desde la DB en getTenantConfig (server runtime).
  if (!isKnownTenantId(tenantId)) {
    return new NextResponse(`Tenant "${tenantId}" not found`, { status: 404 })
  }

  const res = NextResponse.next()
  res.headers.set("x-tenant-id", tenantId)
  return res
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|logos/).*)"],
}
