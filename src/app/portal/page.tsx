import { redirect } from "next/navigation"
import { identidadPortal, urlLogin } from "@/lib/portal-auth"

/**
 * Entrada al portal de clientes. Solo decide a dónde mandar a cada uno.
 *
 * El flujo viejo (OTP de 6 dígitos contra `/api/auth/send-code`) se eliminó: no
 * tenía canal de entrega real, así que en producción el código no le llegaba a
 * nadie, y en desarrollo volvía en la respuesta al mismo que lo pedía — con lo
 * cual cualquiera entraba escribiendo un CUIT ajeno. Ahora autentica Clerk, que
 * ya verifica el email, y el vínculo con el cliente del ERP se resuelve
 * matcheando esa casilla verificada (ver `portal-auth.ts`).
 */
export default async function PortalPage() {
  const identidad = await identidadPortal()

  if (!identidad.clerkUserId && !identidad.codigocliente) {
    redirect(urlLogin("/portal/dashboard"))
  }

  // Logueado pero no lo reconocemos como cliente: entró con un mail que no
  // figura en el ERP. No hay autoservicio para esto todavía — se deriva a
  // atención, que es quien puede cargar el mail correcto en el contacto.
  if (!identidad.codigocliente) redirect("/portal/sin-cuenta")

  redirect("/portal/dashboard")
}
