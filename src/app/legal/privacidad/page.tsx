import type { Metadata } from "next"
import { getTenantConfig } from "@/lib/tenant-context"
import { getLegalInfo } from "@/lib/legal"
import { LegalDoc, Seccion, Dato } from "@/components/portal/LegalDoc"

export async function generateMetadata(): Promise<Metadata> {
  const tenant = await getTenantConfig()
  return {
    title: `Política de privacidad — ${tenant.name}`,
    description: `Cómo ${tenant.name} trata los datos personales de sus clientes.`,
  }
}

export default async function PrivacidadPage() {
  const tenant = await getTenantConfig()
  const legal = getLegalInfo(tenant.id)

  return (
    <LegalDoc title="Política de privacidad" tenantName={tenant.name} logoSrc={tenant.logoPath}>
      <Seccion titulo="Quiénes somos">
        <p>
          <Dato valor={legal.legalName} label="razón social" /> (CUIT{" "}
          <Dato valor={legal.taxId} label="CUIT" />), con domicilio en{" "}
          <Dato valor={legal.address} label="domicilio legal" />, en adelante &laquo;
          {tenant.name}&raquo;, es responsable del tratamiento de los datos personales descriptos
          en este documento.
        </p>
        <p>
          Para cualquier consulta sobre tus datos podés escribirnos a{" "}
          <Dato valor={legal.contactEmail} label="mail de contacto" />.
        </p>
      </Seccion>

      <Seccion titulo="Qué datos recolectamos">
        <p>Según cómo te contactes con nosotros, podemos tratar:</p>
        <ul className="ml-5 flex list-disc flex-col gap-1.5">
          <li>
            <strong>Mensajería (WhatsApp y otros canales):</strong> tu número de teléfono, el
            nombre de tu perfil y el contenido de los mensajes que nos enviás, incluidas las
            imágenes o archivos que adjuntes.
          </li>
          <li>
            <strong>Portal de clientes:</strong> los datos de tu cuenta comercial (razón social,
            datos de contacto, comprobantes, presupuestos y estado de cuenta).
          </li>
          <li>
            <strong>Datos técnicos:</strong> registros de acceso necesarios para operar y proteger
            el servicio.
          </li>
        </ul>
      </Seccion>

      <Seccion titulo="Para qué los usamos">
        <ul className="ml-5 flex list-disc flex-col gap-1.5">
          <li>Responder consultas y brindar atención comercial y postventa.</li>
          <li>Preparar presupuestos, gestionar pedidos y comprobantes.</li>
          <li>Darte acceso a tu cuenta en el portal de clientes.</li>
          <li>Mejorar la calidad de la atención y cumplir obligaciones legales y fiscales.</li>
        </ul>
        <p>
          No vendemos ni cedemos tus datos personales a terceros con fines publicitarios.
        </p>
      </Seccion>

      <Seccion titulo="Atención automatizada">
        <p>
          Parte de la atención por mensajería la realiza un asistente automatizado basado en
          inteligencia artificial, que procesa el contenido de tus mensajes para responderte. Un
          integrante de nuestro equipo puede intervenir en cualquier momento de la conversación, y
          siempre podés pedir hablar con una persona.
        </p>
      </Seccion>

      <Seccion titulo="Con quién los compartimos">
        <p>
          Recurrimos a proveedores que tratan datos por nuestra cuenta y bajo instrucciones
          nuestras: la plataforma de mensajería por la que nos escribís (por ejemplo WhatsApp, de
          Meta Platforms), servicios de infraestructura y alojamiento, proveedores de modelos de
          inteligencia artificial para la atención automatizada, y nuestro sistema de gestión
          administrativa. También podemos compartir información cuando lo exija una autoridad
          competente.
        </p>
        <p>
          Algunos de estos proveedores están radicados fuera de la Argentina, por lo que puede
          existir una transferencia internacional de datos.
        </p>
      </Seccion>

      <Seccion titulo="Cuánto tiempo los conservamos">
        <p>
          Conservamos tus datos mientras dure la relación comercial y, luego, durante los plazos
          que exijan las normas fiscales y comerciales aplicables. Cumplidos esos plazos, los
          eliminamos o anonimizamos.
        </p>
      </Seccion>

      <Seccion titulo="Tus derechos">
        <p>
          Podés solicitar el acceso, la rectificación, la actualización y la supresión de tus datos
          personales escribiendo a{" "}
          <Dato valor={legal.contactEmail} label="mail de contacto" />. Para saber cómo pedir la
          eliminación, ver{" "}
          <a href="/legal/eliminacion-datos" style={{ color: "var(--blue)" }}>
            Eliminación de datos
          </a>
          .
        </p>
        <p className="text-sm">
          El titular de los datos tiene derecho a ejercer el derecho de acceso en forma gratuita a
          intervalos no menores de seis meses, salvo que acredite un interés legítimo (art. 14,
          inc. 3 de la Ley 25.326). La Agencia de Acceso a la Información Pública, órgano de
          control de la Ley 25.326, tiene la atribución de atender las denuncias y reclamos que se
          interpongan con relación al incumplimiento de las normas sobre protección de datos
          personales.
        </p>
      </Seccion>

      <Seccion titulo="Cambios en esta política">
        <p>
          Podemos actualizar esta política. La versión vigente es siempre la publicada en esta
          página, con su fecha de última actualización.
        </p>
      </Seccion>
    </LegalDoc>
  )
}
