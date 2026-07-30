import type { Metadata } from "next"
import { getTenantConfig } from "@/lib/tenant-context"
import { getLegalInfo } from "@/lib/legal"
import { LegalDoc, Seccion, Dato } from "@/components/portal/LegalDoc"

export async function generateMetadata(): Promise<Metadata> {
  const tenant = await getTenantConfig()
  return {
    title: `Términos y condiciones — ${tenant.name}`,
    description: `Condiciones de uso del portal de clientes y los canales de atención de ${tenant.name}.`,
  }
}

export default async function TerminosPage() {
  const tenant = await getTenantConfig()
  const legal = getLegalInfo(tenant.id)

  return (
    <LegalDoc title="Términos y condiciones" tenantName={tenant.name} logoSrc={tenant.logoPath}>
      <Seccion titulo="Alcance">
        <p>
          Estos términos regulan el uso del portal de clientes y de los canales de atención
          (WhatsApp y otros medios de mensajería) que <Dato valor={legal.legalName} label="razón social" />{" "}
          (CUIT <Dato valor={legal.taxId} label="CUIT" />), en adelante &laquo;{tenant.name}&raquo;,
          pone a disposición de sus clientes. Al usarlos, aceptás estas condiciones.
        </p>
      </Seccion>

      <Seccion titulo="Uso del portal de clientes">
        <p>
          El acceso al portal es personal y está destinado a clientes con cuenta activa. Sos
          responsable de resguardar tus credenciales de acceso y de la actividad realizada con
          ellas. Avisanos de inmediato ante cualquier uso no autorizado.
        </p>
        <p>
          La información de tu cuenta (comprobantes, saldos, presupuestos) se muestra a título
          informativo y proviene de nuestro sistema de gestión. Ante cualquier discrepancia, prevalece
          la documentación comercial y fiscal emitida formalmente.
        </p>
      </Seccion>

      <Seccion titulo="Canales de atención y asistente automatizado">
        <p>
          La atención por mensajería puede ser respondida por un asistente automatizado con
          inteligencia artificial. Sus respuestas son orientativas y pueden contener errores: no
          constituyen una oferta vinculante ni asesoramiento técnico definitivo. Podés pedir hablar
          con una persona del equipo en cualquier momento.
        </p>
        <p>
          Al escribirnos, aceptás también las condiciones del proveedor del canal que utilices (por
          ejemplo, WhatsApp).
        </p>
      </Seccion>

      <Seccion titulo="Precios, disponibilidad y presupuestos">
        <p>
          Los precios, el stock y los plazos informados por cualquiera de estos canales son
          referenciales y pueden variar sin aviso previo. Un presupuesto solo obliga a{" "}
          {tenant.name} dentro del plazo de validez indicado en el propio documento.
        </p>
      </Seccion>

      <Seccion titulo="Conducta">
        <p>
          No está permitido usar estos servicios con fines ilícitos, ni intentar acceder a cuentas
          o datos de terceros, ni interferir con el funcionamiento del sistema. Podemos suspender
          el acceso ante un uso indebido.
        </p>
      </Seccion>

      <Seccion titulo="Propiedad intelectual">
        <p>
          Las marcas, logos, textos e imágenes publicados pertenecen a {tenant.name} o a sus
          titulares, y no pueden reproducirse sin autorización.
        </p>
      </Seccion>

      <Seccion titulo="Disponibilidad y responsabilidad">
        <p>
          Procuramos que el servicio esté disponible de forma continua, pero puede interrumpirse
          por mantenimiento o por causas ajenas a nosotros. No respondemos por daños indirectos
          derivados de la falta de disponibilidad del portal o de los canales de atención.
        </p>
      </Seccion>

      <Seccion titulo="Datos personales">
        <p>
          El tratamiento de tus datos se rige por nuestra{" "}
          <a href="/legal/privacidad" style={{ color: "var(--blue)" }}>
            Política de privacidad
          </a>
          .
        </p>
      </Seccion>

      <Seccion titulo="Ley aplicable">
        <p>
          Estos términos se rigen por las leyes de la República Argentina. Ante cualquier
          controversia serán competentes los tribunales ordinarios que correspondan al domicilio
          de <Dato valor={legal.address} label="domicilio legal" />, sin perjuicio de las normas de
          defensa del consumidor que resulten aplicables.
        </p>
        <p>
          Consultas sobre estos términos:{" "}
          <Dato valor={legal.contactEmail} label="mail de contacto" />.
        </p>
      </Seccion>
    </LegalDoc>
  )
}
