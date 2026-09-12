import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { sessionOptions } from "@/lib/session"
import { getTenantConfig } from "@/lib/tenant-context"
import { getDocumentPdf, DOCUMENT_RESOURCES, type DocumentKind } from "@/lib/alegra"
import type { SessionData } from "@/types"

// PDF de un documento del cliente logueado: factura, recibo de pago o presupuesto.
//
// `?download=1` lo baja como archivo; sin eso se sirve inline, para abrirlo en el visor
// del portal sin salir de la página.
//
// El PDF se PROXEA, no se redirige a la URL de Alegra. La URL que da Alegra está firmada:
// quien la tenga entra sin autenticarse. Mandándosela al navegador quedaría en el historial
// y en cualquier log intermedio, y podría compartirse hasta que venza. Acá los bytes salen
// del server y la URL firmada nunca sale de este proceso.

export const dynamic = "force-dynamic"

function isDocumentKind(v: string): v is DocumentKind {
  return v in DOCUMENT_RESOURCES
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  try {
    const { kind, id } = await params

    if (!isDocumentKind(kind)) {
      return Response.json({ error: "Tipo de documento inválido" }, { status: 404 })
    }
    // El id de Alegra es numérico. Filtrarlo acá evita armar rutas raras contra su API.
    if (!/^\d+$/.test(id)) {
      return Response.json({ error: "Documento inválido" }, { status: 400 })
    }

    const cookieStore = await cookies()
    const session = await getIronSession<SessionData>(cookieStore, sessionOptions)
    if (!session.isLoggedIn || !session.codigocliente) {
      return Response.json({ error: "No autorizado" }, { status: 401 })
    }

    const tenant = await getTenantConfig()
    if (tenant.alegraMock) {
      return Response.json({ error: "No disponible en modo mock" }, { status: 501 })
    }

    const doc = await getDocumentPdf(tenant, kind, id)
    if (!doc) {
      return Response.json({ error: "Documento no encontrado" }, { status: 404 })
    }

    // El control que sostiene todo esto: el documento tiene que ser del cliente logueado.
    // Sin esto, cambiar el id en la URL dejaría ver las facturas de cualquier otro cliente
    // del tenant. Un documento sin contacto se trata como ajeno (fail-closed), y se
    // responde 404 —no 403— para no confirmar que ese id existe.
    if (!doc.clientAlegraId || doc.clientAlegraId !== session.codigocliente) {
      return Response.json({ error: "Documento no encontrado" }, { status: 404 })
    }

    if (!doc.pdfUrl) {
      return Response.json({ error: "El documento todavía no tiene PDF disponible" }, { status: 409 })
    }

    const pdf = await fetch(doc.pdfUrl, { cache: "no-store" })
    if (!pdf.ok || !pdf.body) {
      console.error(`documentos: el CDN de Alegra devolvió ${pdf.status} para ${kind} ${id}`)
      return Response.json({ error: "No pudimos obtener el documento" }, { status: 502 })
    }

    const download = new URL(request.url).searchParams.get("download") === "1"
    const safeNumber = (doc.number ?? id).replace(/[^\w.-]+/g, "-")
    const filename = `${kind}-${safeNumber}.pdf`

    return new Response(pdf.body, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
        // Es un documento privado servido tras sesión: que no quede en caches compartidas.
        "Cache-Control": "private, no-store",
      },
    })
  } catch (err) {
    console.error("documentos error:", err)
    return Response.json({ error: "Error interno del servidor" }, { status: 500 })
  }
}
