import type { Metadata } from "next"
import { getTenantConfig } from "@/lib/tenant-context"
import { getLegalInfo } from "@/lib/legal"
import { LegalDoc, Seccion, Dato } from "@/components/portal/LegalDoc"

export async function generateMetadata(): Promise<Metadata> {
  const tenant = await getTenantConfig()
  return {
    title: `Eliminación de datos — ${tenant.name}`,
    description: `Cómo solicitar la eliminación de sus datos personales a ${tenant.name}.`,
  }
}

export default async function EliminacionDatosPage() {
  const tenant = await getTenantConfig()
  const legal = await getLegalInfo(tenant.id)

  return (
    <LegalDoc
      title="Instrucciones para la eliminación de datos"
      tenantName={tenant.name}
      logoSrc={tenant.logoPath}
    >
      <Seccion titulo="Cómo pedir la eliminación de sus datos">
        <p>
          Si desea que <Dato valor={legal.legalName} label="razón social" /> elimine los datos
          personales que tiene sobre usted, siga estos pasos:
        </p>
        <ol className="ml-5 flex list-decimal flex-col gap-1.5">
          <li>
            Escriba un correo a <Dato valor={legal.contactEmail} label="mail de contacto" /> con el
            asunto <strong>&laquo;Eliminación de datos&raquo;</strong>.
          </li>
          <li>
            Indique el número de teléfono con el que nos escribió y, si es cliente, su razón
            social o número de cuenta, para poder identificarte.
          </li>
          <li>
            Aclare si desea eliminar el historial de conversaciones, los datos de su cuenta, o
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
          Los mensajes almacenados en su propio dispositivo o en su cuenta de WhatsApp los
          administra el proveedor del servicio, no nosotros. Para borrarlos, use las opciones de la
          aplicación o consulte la política de privacidad de ese proveedor.
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
