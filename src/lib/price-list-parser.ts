import * as XLSX from "xlsx"

export type PriceColumn = { key: string; label: string }

export type ParsedItem = {
  code: string
  description: string
  prices: Record<string, string>
}

export type ParseResult = {
  columns: PriceColumn[]
  items: ParsedItem[]
  errors: string[]
}

/**
 * Parsea un Excel con formato:
 * Código | (vacíos) | Descripción | (vacíos) | Lista 1 | Lista 2 | Lista 3 ...
 *
 * Busca la columna "Código" y "Descripción" por nombre en la primera fila,
 * y trata como listas de precio todas las columnas con nombre no vacío que
 * aparecen después de la descripción.
 */
export function parsePriceListExcel(buffer: Buffer): ParseResult {
  const workbook = XLSX.read(buffer, { type: "buffer" })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "" })

  const errors: string[] = []

  if (rows.length < 2) {
    return { columns: [], items: [], errors: ["El archivo no tiene datos"] }
  }

  const header = (rows[0] as string[]).map((h) => String(h).trim())

  // Buscar índices por nombre (case-insensitive)
  const codeIdx = header.findIndex((h) => /^c[oó]d/i.test(h))
  const descIdx = header.findIndex((h) => /^desc/i.test(h))

  if (codeIdx === -1) return { columns: [], items: [], errors: ["No se encontró la columna 'Código'"] }
  if (descIdx === -1) return { columns: [], items: [], errors: ["No se encontró la columna 'Descripción'"] }

  // Columnas de precio: las que tienen nombre no vacío y aparecen después de la descripción
  const priceIdxs: { idx: number; label: string }[] = []
  for (let i = descIdx + 1; i < header.length; i++) {
    if (header[i]) priceIdxs.push({ idx: i, label: header[i] })
  }

  if (priceIdxs.length === 0) {
    return { columns: [], items: [], errors: ["No se encontraron columnas de precios después de 'Descripción'"] }
  }

  const columns: PriceColumn[] = priceIdxs.map((p, i) => ({
    key: `lista${i + 1}`,
    label: p.label,
  }))

  const items: ParsedItem[] = []

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as string[]
    const code = String(row[codeIdx] ?? "").trim()
    const description = String(row[descIdx] ?? "").trim()

    if (!code && !description) continue

    if (!code) {
      errors.push(`Fila ${i + 1}: sin código`)
      continue
    }

    const prices: Record<string, string> = {}
    priceIdxs.forEach((p, colI) => {
      const raw = String(row[p.idx] ?? "0").replace(/\./g, "").replace(",", ".")
      const num = parseFloat(raw)
      prices[columns[colI].key] = isNaN(num) ? "0" : num.toFixed(2)
    })

    items.push({ code, description, prices })
  }

  return { columns, items, errors }
}
