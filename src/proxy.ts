import { NextRequest, NextResponse, type NextFetchEvent } from "next/server"
import { clerkMiddleware } from "@clerk/nextjs/server"
import { isKnownTenantId, resolveTenantIdFromHost } from "@/lib/tenants"
import { checkSiteGate } from "@/lib/site-gate"

/**
 * Clerk como identidad del portal de clientes.
 *
 * El CRM es un **satellite** de la aplicación de Clerk del Shop: hay un solo
 * login para los dos, y el cliente que entró en la tienda no vuelve a
 * autenticarse acá. El login vive en el dominio primario (el Shop); este
 * dominio solo valida la sesión. Config por env — ver .env.example.
 *
 * Next 16 admite UNA sola función proxy, así que esto se compone con la
 * resolución de tenant y el gate, en ese orden: tenant primero (sin tenant
 * válido no hay nada que servir), gate después, Clerk al final.
 *
 * NOTA: /admin sigue con su propio login (iron-session + adminUsers). Son otro
 * público — operadores, no clientes — y no comparten sesión con la tienda.
 */
const clerk = clerkMiddleware((_auth, req) => {
  // El header de tenant se recalcula acá adentro porque `NextResponse.next()`
  // se crea dentro del handler de Clerk: si se armara afuera, Clerk devolvería
  // su propia respuesta y el header se perdería silenciosamente.
  const host = req.headers.get("host") ?? ""
  const tenantId = process.env.TENANT_OVERRIDE || resolveTenantIdFromHost(host)
  const res = NextResponse.next()
  res.headers.set("x-tenant-id", tenantId)
  return res
})

export async function proxy(req: NextRequest, event: NextFetchEvent) {
  const host = req.headers.get("host") ?? ""

  // El subdominio `crm.*` es solo backoffice — no tiene portal público. Mandamos la raíz
  // directo a /admin para que el operador (o la PWA instalada, cuyo start_url es "/") no
  // aterrice en el gate "Próximamente". 307 = temporary (evita cachear la regla en el
  // navegador si en el futuro `/` sirve para otra cosa).
  if (req.nextUrl.pathname === "/" && host.startsWith("crm.")) {
    return NextResponse.redirect(new URL("/admin", req.url), 307)
  }

  // `|| undefined`, no `??`: un TENANT_OVERRIDE="" (seteada pero vacía, como quedó en algún
  // momento en prod) no debe pisar la resolución por host. ?? solo cae al fallback con
  // null/undefined, así que un string vacío rompía TODAS las requests con 404.
  const override = process.env.TENANT_OVERRIDE || undefined
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

  // Clerk corre último y es quien arma la respuesta final (con el x-tenant-id
  // adentro). Devolver `NextResponse.next()` acá dejaría a Clerk sin correr y
  // `auth()` fallaría en todo el portal.
  return clerk(req, event)
}

export const config = {
  // Excluir manifest.webmanifest y sw.js: son assets del PWA y el proxy los estaba tapando
  // con el HTML del gate ("Próximamente"), rompiendo la instalación en mobile — al navegador
  // le llegaba HTML en vez del JSON/JS y no podía leer el manifest ni registrar el SW.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|logos/|manifest.webmanifest|sw.js).*)"],
}
