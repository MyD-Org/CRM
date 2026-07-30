import type { Metadata } from "next"
import { getTenantConfig } from "@/lib/tenant-context"
import { getLegalInfo } from "@/lib/legal"
import { LegalDoc, Seccion, Dato } from "@/components/portal/LegalDoc"

export async function generateMetadata(): Promise<Metadata> {
  const tenant = await getTenantConfig()
  return {
    title: `Eliminación de datos — ${tenant.name}`,
    description: `Cómo solicitar la eliminación de tus datos personales a ${tenant.name}.`,
  }
}

export default async function EliminacionDatosPage() {
  const tenant = await getTenantConfig()
  const legal = getLegalInfo(tenant.id)

  return (
    <LegalDoc
      title="Instrucciones para la eliminación de datos"
      tenantName={tenant.name}
      logoSrc={tenant.logoPath}
    >
      <Seccion titulo="Cómo pedir la eliminación de tus datos">
        <p>
          Si querés que <Dato valor={legal.legalName} label="razón social" /> elimine los datos
          personales que tiene sobre vos, seguí estos pasos:
        </p>
        <ol className="ml-5 flex list-decimal flex-col gap-1.5">
          <li>
            Escribí un correo a <Dato valor={legal.contactEmail} label="mail de contacto" /> con el
            asunto <strong>&laquo;Eliminación de datos&raquo;</strong>.
          </li>
          <li>
            Indicá el número de teléfono con el que nos escribiste y, si sos cliente, tu razón
            social o número de cuenta, para poder identificarte.
          </li>
          <li>
            Aclará si querés eliminar el historial de conversaciones, los datos de tu cuenta, o
            ambos.
          </li>
        </ol>
      </Seccion>

      <Seccion titulo="Plazos">
        <p>
          Vamos a confirmarte la recepción del pedido y a resolverlo dentro de los plazos previstos
          por la Ley 25.326 de Protección de los Datos Personales.
        </p>
      </Seccion>

      <Seccion titulo="Qué datos no podemos eliminar">
        <p>
          La normativa fiscal y comercial nos obliga a conservar durante determinados plazos los
          comprobantes emitidos y los registros contables asociados a operaciones realizadas
          (facturas, remitos, pagos). Esa información no puede eliminarse hasta que venzan esos
          plazos; el resto de los datos sí se elimina.
        </p>
      </Seccion>

      <Seccion titulo="Datos en la plataforma de mensajería">
        <p>
          Los mensajes almacenados en tu propio dispositivo o en tu cuenta de WhatsApp los
          administra el proveedor del servicio, no nosotros. Para borrarlos, usá las opciones de la
          aplicación o consultá la política de privacidad de ese proveedor.
        </p>
      </Seccion>

      <Seccion titulo="Más información">
        <p>
          Ver también nuestra{" "}
          <a href="/legal/privacidad" style={{ color: "var(--blue)" }}>
            Política de privacidad
          </a>
          .
        </p>
      </Seccion>
    </LegalDoc>
  )
}
