/**
 * Datos legales del tenant para las páginas públicas de /legal.
 *
 * Viven en la tabla `tenants` (columnas `legal_*`), igual que el resto de la config del
 * tenant: dar de alta un cliente no debería requerir tocar variables de entorno ni un
 * redeploy. Antes salían de env vars `{PREFIX}_LEGAL_*`; ver migración 0019.
 *
 * Este repo es público: los datos reales de cada tenant NO se hardcodean acá.
 */

import { eq } from "drizzle-orm"

export interface LegalInfo {
  /** Razón social */
  legalName: string
  /** CUIT */
  taxId: string
  /** Domicilio legal */
  address: string
  /** Mail de contacto para ejercer derechos sobre los datos */
  contactEmail: string
  /** false si falta algún dato (las páginas lo marcan como pendiente) */
  isComplete: boolean
}

/** Fecha de última actualización que se muestra en los documentos. */
export const LEGAL_LAST_UPDATED = "30 de julio de 2026"

const VACIO: LegalInfo = {
  legalName: "",
  taxId: "",
  address: "",
  contactEmail: "",
  isComplete: false,
}

export async function getLegalInfo(tenantId: string): Promise<LegalInfo> {
  try {
    const { getDb } = await import("@/db")
    const { tenants } = await import("@/db/schema")

    const [row] = await getDb()
      .select({
        legalName: tenants.legalName,
        taxId: tenants.legalTaxId,
        address: tenants.legalAddress,
        contactEmail: tenants.legalEmail,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))

    if (!row) return VACIO

    return { ...row, isComplete: Object.values(row).every(Boolean) }
  } catch (err) {
    // Estas páginas tienen que seguir sirviendo aunque la DB no responda: Meta las exige
    // accesibles sin login para la revisión de la app de WhatsApp. Sin datos, cada campo
    // se muestra como "[pendiente: ...]" en vez de tirar un 500.
    console.error("getLegalInfo: DB no disponible:", err)
    return VACIO
  }
}
