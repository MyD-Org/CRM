import { NextRequest, NextResponse } from "next/server"
import { isKnownTenantId, resolveTenantIdFromHost, tenantOverride } from "@/lib/tenants"
import { checkSiteGate } from "@/lib/site-gate"

export async function proxy(req: NextRequest) {
  const host = req.headers.get("host") ?? ""

  // El subdominio `crm.*` es solo backoffice — no tiene portal público. Mandamos la raíz
  // directo a /admin para que el operador (o la PWA instalada, cuyo start_url es "/") no
  // aterrice en el gate "Próximamente". 307 = temporary (evita cachear la regla en el
  // navegador si en el futuro `/` sirve para otra cosa).
  if (req.nextUrl.pathname === "/" && host.startsWith("crm.")) {
    return NextResponse.redirect(new URL("/admin", req.url), 307)
  }

  // `tenantOverride()` y no `process.env.TENANT_OVERRIDE` directo: en producción devuelve
  // undefined, así que el override NO puede pisar la resolución por host. Si el proxy lo
  // honrara y el guard no, el usuario entra (proxy) y el panel lo expulsa (guard): loop de
  // redirect, un modo de falla que parece caída de servicio. Los dos leen la misma función.
  const override = tenantOverride()
  const tenantId = override ?? resolveTenantIdFromHost(host)

  // La config completa del tenant se carga desde la DB en getTenantConfig (server runtime).
  if (!isKnownTenantId(tenantId)) {
    return new NextResponse(`Tenant "${tenantId}" not found`, { status: 404 })
  }

  // Gate temporal mientras el CRM no esta listo para produccion. Solo tapa
  // paginas: /api/* ya tiene su propia auth (Bearer, iron-session, CRON_SECRET)
  // y la usan integraciones externas (bots de WhatsApp/IG, cron) que no van
  // a mandar la cookie del gate. /legal/* queda publica: Meta la exige accesible
  // sin login para la revision de la app de WhatsApp/Instagram. /admin/* sale a
  // produccion: ya tiene su propio login real (iron-session), el gate ahi era
  // una capa extra redundante. /onboarding/* es el destino del redirect de Meta
  // al conectar WhatsApp: lo abre el dueño del numero, que no tiene sesion del
  // CRM; se protege solo con el `state` secreto del link (ver la page).
  if (
    !req.nextUrl.pathname.startsWith("/api/") &&
    !req.nextUrl.pathname.startsWith("/legal/") &&
    !req.nextUrl.pathname.startsWith("/admin") &&
    !req.nextUrl.pathname.startsWith("/onboarding/")
  ) {
    const gated = await checkSiteGate(req)
    if (gated) return gated
  }

  // No confiar en un header x-tenant-id provisto por el cliente: sobreescribirlo
  // y adjuntarlo a la REQUEST que seguirá hacia los server components. Esto asegura
  // que `headers()` en server runtime reciba el valor correcto.
  const requestHeaders = new Headers(req.headers)
  requestHeaders.set("x-tenant-id", tenantId)
  return NextResponse.next({ request: { headers: requestHeaders } })
}

export const config = {
  // Excluir manifest.webmanifest y sw.js: son assets del PWA y el proxy los estaba tapando
  // con el HTML del gate ("Próximamente"), rompiendo la instalación en mobile — al navegador
  // le llegaba HTML en vez del JSON/JS y no podía leer el manifest ni registrar el SW.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|logos/|manifest.webmanifest|sw.js).*)"],
}
