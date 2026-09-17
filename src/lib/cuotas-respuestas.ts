import type { ResultadoMedio, ResultadoOpcion } from "@/lib/cuotas-repo"

// Respuestas de error compartidas por /api/admin/cuotas/*. Todas 422 con `code` estable para
// que el backoffice muestre el error inline en el campo (`campo`) o como aviso general.

export const NO_STORE = { "Cache-Control": "private, no-store" }

type ErrorKind = Exclude<ResultadoMedio | ResultadoOpcion, { kind: "ok" } | { kind: "not_found" }>

export function cuotasErrorResponse(r: ErrorKind): Response {
  switch (r.kind) {
    case "invalid":
      return Response.json({ error: r.error, code: "invalid", campo: r.campo }, { status: 422, headers: NO_STORE })
    case "duplicado":
      return Response.json(
        { error: "Ese medio (proveedor + código) ya existe", code: "duplicado", campo: "codigoProveedor" },
        { status: 422, headers: NO_STORE },
      )
    case "superpuesta":
      return Response.json(
        {
          error: "Ya hay una opción activa de ese medio con las mismas cuotas en esas fechas",
          code: "superpuesta",
          campo: "cuotas",
          conId: r.conId,
        },
        { status: 422, headers: NO_STORE },
      )
  }
}
