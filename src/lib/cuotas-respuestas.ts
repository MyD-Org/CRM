import type { ResultadoEscalon, ResultadoProveedor } from "@/lib/cuotas-repo"

// Respuestas de error compartidas por /api/admin/cuotas/*. Todas 422 con `code` estable para
// que el backoffice muestre el error inline en el campo (`campo`) o como aviso general.

export const NO_STORE = { "Cache-Control": "private, no-store" }

type ErrorKind = Exclude<ResultadoProveedor | ResultadoEscalon, { kind: "ok" } | { kind: "not_found" }>

export function cuotasErrorResponse(r: ErrorKind): Response {
  switch (r.kind) {
    case "invalid":
      return Response.json({ error: r.error, code: "invalid", campo: r.campo }, { status: 422, headers: NO_STORE })
    case "duplicado":
      return Response.json(
        { error: "Ese proveedor ya está configurado", code: "duplicado", campo: "proveedor" },
        { status: 422, headers: NO_STORE },
      )
    case "monto_repetido":
      return Response.json(
        {
          error: "Ya hay un escalón activo de ese proveedor con el mismo monto mínimo",
          code: "monto_repetido",
          campo: "montoMinimo",
          conId: r.conId,
        },
        { status: 422, headers: NO_STORE },
      )
  }
}
