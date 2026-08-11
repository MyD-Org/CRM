/**
 * Identidad del portal de clientes. SOLO servidor.
 *
 * El CRM tiene su **propia** aplicación de Clerk, separada de la del Shop. Se
 * evaluó una sola instancia con satellite domains (un único login para los dos)
 * y se descartó: en producción los satellite domains requieren plan pago.
 *
 * Consecuencia directa, y conviene tenerla presente: los `clerkUserId` de los
 * dos sistemas NO se corresponden. La misma persona es un usuario distinto en
 * cada uno, y cada sistema mantiene su propia tabla de vínculos. No es
 * duplicación evitable — es el precio de esa decisión.
 *
 * Cómo se prueba quién es el cliente, sin pedirle nada:
 *
 *   Clerk dice:  esta persona controla juan@empresa.com   (ya verificado)
 *   El ERP dice: juan@empresa.com es ACME SRL
 *   ─────────────────────────────────────────────────────
 *                esta persona es ACME SRL
 *
 * Es la misma prueba que daría un código por email —controlar la casilla que el
 * sistema ya tiene registrada— solo que Clerk la hizo al autenticar. Por eso el
 * portal no necesita su propio OTP.
 *
 * Durante la transición se acepta también la cookie vieja de iron-session, para
 * que quien ya estaba logueado no quede afuera de golpe.
 */

import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { auth, currentUser } from "@clerk/nextjs/server"
import { and, eq } from "drizzle-orm"
import { getDb } from "@/db"
import { portalClientLinks } from "@/db/schema"
import { searchContacts } from "@/lib/alegra"
import { getTenantConfig } from "@/lib/tenant-context"
import { sessionOptions } from "@/lib/session"
import type { TenantConfig } from "@/lib/tenants"
import type { SessionData } from "@/types"

export interface IdentidadPortal {
  /** Id de Clerk. null = no hay sesión de Clerk (puede haber cookie vieja). */
  clerkUserId: string | null
  /** Contacto del ERP vinculado. null = logueado pero sin cuenta reconocida. */
  codigocliente: string | null
  razonsocial?: string
  email?: string
  /** De dónde salió la identidad, para poder medir la transición. */
  origen: "clerk" | "cookie_crm" | "anonimo"
}

/** Sesión heredada del portal viejo. Se apaga cuando la migración termine. */
async function sesionLegacy(): Promise<SessionData | null> {
  try {
    const cookieStore = await cookies()
    const s = await getIronSession<SessionData>(cookieStore, sessionOptions)
    return s.isLoggedIn && s.codigocliente ? s : null
  } catch {
    return null
  }
}

/** Vínculo activo de este usuario en este tenant, si existe. */
async function vinculoActivo(tenantId: string, clerkUserId: string) {
  const [fila] = await getDb()
    .select()
    .from(portalClientLinks)
    .where(
      and(
        eq(portalClientLinks.tenantId, tenantId),
        eq(portalClientLinks.clerkUserId, clerkUserId),
        eq(portalClientLinks.estado, "activa"),
      ),
    )
    .limit(1)
  return fila ?? null
}

/**
 * Match automático por email verificado. Se ejecuta como mucho UNA vez por
 * usuario: el resultado —haya coincidencia o no— queda registrado, así una
 * cuenta sin match no dispara una consulta al ERP en cada visita.
 */
async function intentarVincularPorEmail(
  config: TenantConfig,
  clerkUserId: string,
  email: string | undefined,
) {
  if (!email) return null
  const db = getDb()

  // ¿Ya se resolvió antes? Cubre tanto un vínculo activo como un intento previo
  // sin resultado. Una sola query indexada.
  const [existente] = await db
    .select({ id: portalClientLinks.id })
    .from(portalClientLinks)
    .where(
      and(
        eq(portalClientLinks.tenantId, config.id),
        eq(portalClientLinks.clerkUserId, clerkUserId),
      ),
    )
    .limit(1)
  if (existente) return null

  let contactos
  try {
    contactos = await searchContacts(config, email, 5)
  } catch (err) {
    // ERP caído: NO se registra "sin coincidencia", porque no buscamos de
    // verdad. Se reintenta en la próxima visita.
    console.error("[portal-auth] el ERP falló al buscar por email:", err)
    return null
  }

  // `searchContacts` matchea por identificación O email; acá solo vale el email
  // exacto, que es lo único que Clerk verificó.
  const exactos = contactos.filter(
    (c) => (c.email ?? "").toLowerCase() === email.toLowerCase(),
  )

  // Dos contactos con la misma casilla: ambiguo. Elegir uno sería vincular a la
  // empresa equivocada la mitad de las veces.
  if (exactos.length !== 1) {
    await db.insert(portalClientLinks).values({
      tenantId: config.id,
      clerkUserId,
      codigocliente: "",
      estado: "sin_coincidencia",
      metodo: "email_verificado",
    })
    return null
  }

  const contacto = exactos[0]
  await db.insert(portalClientLinks).values({
    tenantId: config.id,
    clerkUserId,
    codigocliente: String(contacto.alegraId),
    razonsocial: contacto.name ?? null,
    cuit: contacto.identification ?? null,
    estado: "activa",
    metodo: "email_verificado",
  })

  return { codigocliente: String(contacto.alegraId), razonsocial: contacto.name }
}

export async function identidadPortal(): Promise<IdentidadPortal> {
  const { userId } = await auth()

  if (userId) {
    const config = await getTenantConfig()

    const vinculo = await vinculoActivo(config.id, userId)
    if (vinculo) {
      return {
        clerkUserId: userId,
        codigocliente: vinculo.codigocliente,
        razonsocial: vinculo.razonsocial ?? undefined,
        origen: "clerk",
      }
    }

    const user = await currentUser()
    const emailPrimario = user?.primaryEmailAddress
    const email = emailPrimario?.emailAddress

    /**
     * SOLO un email VERIFICADO habilita la vinculación automática.
     *
     * Es la condición de la que depende todo el mecanismo: el razonamiento es
     * "Clerk probó que esta persona controla la casilla, y el ERP dice de quién
     * es esa casilla". Si el email no está verificado, el primer eslabón no
     * existe y la cadena no prueba nada.
     *
     * Sin este chequeo, cualquiera se registra con el email de un cliente —que
     * está en sus facturas, en su web, en una tarjeta— y ve su cuenta corriente,
     * su saldo y sus facturas.
     *
     * No alcanza con que hoy el dashboard tenga "Verify at sign-up" activado:
     * eso es configuración que alguien puede apagar sin darse cuenta de que
     * estaba sosteniendo una garantía de seguridad.
     */
    const emailVerificado =
      emailPrimario?.verification?.status === "verified" ? email : undefined

    const auto = await intentarVincularPorEmail(config, userId, emailVerificado)

    return {
      clerkUserId: userId,
      codigocliente: auto?.codigocliente ?? null,
      razonsocial: auto?.razonsocial ?? user?.fullName ?? undefined,
      email,
      origen: "clerk",
    }
  }

  const legacy = await sesionLegacy()
  if (legacy) {
    return {
      clerkUserId: null,
      codigocliente: legacy.codigocliente!,
      razonsocial: legacy.razonsocial,
      email: legacy.email,
      origen: "cookie_crm",
    }
  }

  return { clerkUserId: null, codigocliente: null, origen: "anonimo" }
}

/**
 * URL del login. Vive en ESTE dominio: con aplicaciones de Clerk separadas, el
 * CRM autentica por su cuenta y no delega en el Shop.
 */
export function urlLogin(redirectTo?: string): string {
  const base = "/portal/ingresar"
  if (!redirectTo) return base
  return `${base}?redirect_url=${encodeURIComponent(redirectTo)}`
}
