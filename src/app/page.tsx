import { redirect } from "next/navigation"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

// El `start_url` de la PWA es "/". Redirigimos según quién está logueado en el dispositivo:
// un operador (sesión de admin) abre la app instalada en el backoffice; cualquier otro visitante
// —incluido un cliente— va al portal. Así el mismo manifest sirve a ambos roles sin romper la
// experiencia del cliente. Si la sesión de admin caducó, /admin ya redirige a su login.
export default async function RootPage() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  redirect(session.userId ? "/admin" : "/portal")
}
