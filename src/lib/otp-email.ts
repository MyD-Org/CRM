import type { TenantConfig } from "@/lib/tenants"

// Formato pensado para que el celular ofrezca "Copiar código" desde la notificación,
// sin abrir el mail. No hay estándar para email (el `@dominio #código` es solo de SMS):
// iOS y Gmail lo detectan por heurística, así que el mail cumple lo que esa heurística
// busca — el código en el asunto, la frase "código de verificación" pegada al número,
// los 6 dígitos SIN separadores ni espaciado que los parta, y una parte en texto plano
// (`text`), que es la que suelen parsear. Si se cambia la redacción, mantener la frase
// "Tu código de verificación es NNNNNN" literal en el texto plano y el número en el asunto.
//
// NO agregar un botón de "copiar código": los clientes de mail no ejecutan JavaScript
// (Gmail, Outlook y Apple Mail lo bloquean), así que sería un botón muerto. Lo más
// cercano que funciona es un link al portal, evaluado y descartado por ahora.
export function buildOtpEmail(tenant: TenantConfig, razonsocial: string, otp: string) {
  return {
    subject: `${otp} es tu código de verificación de ${tenant.name}`,
    text:
      `Tu código de verificación es ${otp}\n\n` +
      `Hola ${razonsocial}: usá este código para entrar al portal de clientes de ${tenant.name}. ` +
      `Vence en 10 minutos y sirve una sola vez.\n\n` +
      `Si no pediste este código, ignorá este mensaje: sin él nadie puede entrar a tu cuenta.`,
    // Maquetado con tablas y estilos inline: es lo único que renderiza parejo en todos
    // los clientes de mail (Outlook de escritorio usa el motor de Word — ignora flex,
    // grid y border-radius, pero respeta las tablas y degrada sin romperse).
    html: `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#eef1f5;padding:32px 16px">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:440px;background:#ffffff;border-radius:12px;border-top:3px solid #1f8cff">
      <tr><td style="padding:28px 32px 0">
        <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280">${tenant.name}</div>
      </td></tr>
      <tr><td style="padding:20px 32px 0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.55;color:#111827">
        <p style="margin:0 0 4px">Hola ${razonsocial},</p>
        <p style="margin:0">Tu código de verificación es:</p>
      </td></tr>
      <tr><td style="padding:20px 32px 0">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f6f8fb;border:1px solid #e5e7eb;border-radius:8px">
          <tr><td align="center" style="padding:18px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:34px;font-weight:700;color:#111827">${otp}</td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:16px 32px 28px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;line-height:1.55;color:#6b7280">
        <p style="margin:0">Vence en 10 minutos y sirve una sola vez.</p>
        <p style="margin:16px 0 0;padding-top:16px;border-top:1px solid #eef1f5">Si no pediste este código, ignorá este mensaje: sin él nadie puede entrar a tu cuenta.</p>
      </td></tr>
    </table>
    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:12px;color:#9ca3af;padding:16px 0 0">Portal de clientes de ${tenant.name}</div>
  </td></tr>
</table>`,
  }
}
