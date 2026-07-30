/**
 * Datos legales del tenant para las páginas públicas de /legal.
 *
 * Vienen de env vars (no de la DB) porque son estáticos y así evitamos una migración:
 *   CENTRAL_LED_LEGAL_NAME, CENTRAL_LED_LEGAL_TAX_ID, CENTRAL_LED_LEGAL_ADDRESS,
 *   CENTRAL_LED_LEGAL_EMAIL
 *
 * Este repo es público: los datos reales de cada tenant NO se hardcodean acá.
 */

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

export function getLegalInfo(tenantId: string): LegalInfo {
  const prefix = tenantId.toUpperCase().replace(/-/g, "_")
  const read = (key: string) => process.env[`${prefix}_LEGAL_${key}`]?.trim() ?? ""

  const info = {
    legalName: read("NAME"),
    taxId: read("TAX_ID"),
    address: read("ADDRESS"),
    contactEmail: read("EMAIL"),
  }

  return { ...info, isComplete: Object.values(info).every(Boolean) }
}
