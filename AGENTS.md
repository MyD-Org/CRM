<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Ecosistema MyD-Org

Este CRM es **uno de varios productos** de MyD-Org pensados para integrarse entre sí
pero también venderse por separado. El contexto compartido (mapa de productos,
contratos de integración y decisiones) vive en el repo **[`MyD-Org/platform`](https://github.com/MyD-Org/platform)**.

**Antes de trabajar en una integración, leé el contrato correspondiente en `platform`.**

Integraciones de este repo:
- **Chat de soporte (ai-widget + ai-api)**: el portal embebe el widget; las tools del
  agente consultan `/api/agent/*` de este CRM con un `crm_token` (HMAC).
  Contrato: `platform/contracts/crm-ai-api.md`. Decisión de auth: `platform/decisions/0001`.
- **Design system (`MyD-Org/ui`)** *(futuro)*: componentes y tokens compartidos.
- **Shop online** *(futuro)*: consumirá datos de cuenta del cliente de este CRM.

Si cambiás un contrato (ej. un endpoint `/api/agent/*` o el formato del token),
**actualizá el doc en `platform` en el mismo cambio** y avisá al otro proyecto.

Funcionalidades de este repo documentadas en `docs/FUNCIONALIDADES.md`.
