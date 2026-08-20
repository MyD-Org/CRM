import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

/**
 * Destruye una sesión que el guard rechazó y manda al login.
 *
 * Existe porque en App Router `cookies()` es de solo lectura fuera de Server Actions y Route
 * Handlers: `session.destroy()` / `session.save()` desde `(protected)/layout.tsx` tiran
 * "Cookies can only be modified in a Server Action or Route Handler". El layout redirige acá.
 *
 * Hermano de `/api/admin/auth/logout`, con dos diferencias deliberadas:
 *  - Acepta **GET**: es destino de un `redirect()` (logout es POST, disparado por el usuario).
 *  - **NO escribe `availability = "away"`** (a diferencia de logout / ADR 0006). Un GET es
 *    CSRF-able: un `<img src=".../expire">` sacaría al operador de la cola de asignación en
 *    silencio y le desviaría los handoffs. Destruir una cookie por CSRF es molestia menor;
 *    sacarlo de la cola, no. Sin escritura de estado, `expire` es idempotente e inocuo.
 */
export async function GET(req: Request) {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  session.destroy()
  // 303: el resultado del GET es "andá a esta otra URL", y fuerza GET en el destino.
  return NextResponse.redirect(new URL("/admin/login?expired=1", req.url), 303)
}
