# Pedidos Avantec — la parte que le toca al CRM

> Documento complementario a *"Propuesta: Automatización del flujo de pedidos — Avantec"*
> (que vive en el repo del sistema de inventario). Aquel describe el flujo completo;
> **este describe qué construye este repo (el CRM) y cómo se conecta con el inventario**.
>
> Estado: propuesta de trabajo. Nada de esto está implementado todavía.

## 1. Corrección de prioridades respecto de la propuesta original

La propuesta original manda el **parser IA de mensajes** a la Fase 3 ("Inteligencia"),
con esfuerzo *Alto*. Del lado del CRM esa estimación está desactualizada: la
infraestructura cara del parser **ya existe y está en producción**.

| Lo que el parser necesita | Estado hoy en el CRM |
|---|---|
| Recibir mensajes de WhatsApp | ✅ `ai-api` + inbox (`src/lib/inbox-api.ts`) |
| Un agente con tools que consulten datos reales | ✅ `/api/agent/*` con `crm_token` HMAC (`agent-auth.ts`) |
| Que el bot pueda **pasar la charla a un humano** | ✅ modo `bot`/`human` + handoff ruteado por departamento (ADR 0006) |
| Cola de operadores y asignación | ✅ `departments`, `conversation_assignments`, `lib/assignment.ts` |
| Que el operador vea el hilo completo y responda | ✅ inbox por contacto (`ContactThreadView.tsx`) |
| Copiloto que ayuda al operador con IA | ✅ `AiAssistPanel.tsx` (ADR 0007) |
| Ventana de 24hs, plantillas de Meta, reintentos de envío | ✅ `TemplateManager.tsx`, `retryMessage`/`dismissMessage` |
| Guardrails de gasto del bot | ✅ `getLimits`/`setLimits`, panel de uso |

Lo que falta es **el dominio "pedido"**, no la plomería: un conjunto de tools nuevas
para el agente y una entidad de pedido con la que conversar. Por eso la propuesta
que sigue **mueve el parser a la Fase 1**, junto con el módulo de pedidos y el BOM.

Un segundo cambio: el parser **no** es la única puerta de entrada. La comanda tiene
que poder cargarse **a mano** (teléfono, presencial, pedido de stock, cliente que
manda un PDF), y esa carga manual es la que define la entidad. El parser es un
*productor* más de esa misma entidad, no un camino paralelo.

---

## 2. Principio de diseño: una sola entidad, tres orígenes

```
WhatsApp  →  agente IA (slot filling)  ─┐
Email     →  agente IA (slot filling)  ─┤
Teléfono / presencial / stock → carga manual en el admin ─┤
                                        │
                                        ▼
                            BORRADOR DE PEDIDO (CRM)
                                        │
                              confirmado por humano
                              o por el cliente
                                        ▼
                        POST /pedidos → Sistema de Inventario
                                        │
                              webhook de cambios de status
                                        ▼
                        notificación al cliente (WhatsApp)
```

**El borrador vive en el CRM. El pedido firme vive en el inventario.** Esa separación
es la que hace que el parser pueda equivocarse sin ensuciar el stock: mientras el
pedido está en borrador nadie reservó materia prima.

### Por qué un borrador y no crear el pedido directo

- Un parser que crea pedidos firmes obliga a que el inventario sepa de "pedidos
  dudosos", "pedidos a medio completar" y "pedidos que el cliente abandonó". Eso es
  dominio de conversación, no de producción.
- El borrador puede quedarse días incompleto esperando que el cliente conteste
  "¿grampa larga o corta?". Un pedido firme, no.
- Cuando el bot no entiende, el operador **hereda el borrador con lo que se pudo
  sacar** y completa lo que falta. Sin borrador, el handoff empieza de cero.

---

## 3. El borrador de pedido

Los campos salen de la comanda de papel actual (sección 2 de la propuesta original).

```ts
// esbozo — el schema definitivo va en src/db/schema.ts
order_drafts {
  id, tenant_id,
  origin: 'whatsapp' | 'email' | 'phone' | 'in_person' | 'manual',
  // Trazabilidad al hilo que lo originó (null en carga manual).
  end_user_id, conversation_id,
  // Contacto de Alegra si se pudo identificar; si no, los datos crudos.
  contact_id, contact_name, contact_phone,
  delivery_date_estimate, priority, notes,
  status: 'collecting' | 'needs_human' | 'ready' | 'submitted' | 'cancelled',
  confidence,            // qué tan seguro está el parser de lo que armó
  submitted_order_id,    // id que devolvió el inventario
  created_at, updated_at
}

order_draft_items {
  id, draft_id,
  product, quantity,
  clamp: 'larga' | 'corta',        // grampa
  led_color, optic, body_color,
  other,                            // la columna libre de la comanda
  // Por campo: 'parsed' | 'asked' | 'assumed' | 'manual' — para pintar en la UI
  // qué dijo el cliente, qué preguntó el bot y qué asumió.
  field_sources
}
```

`field_sources` no es adorno: es lo que le permite al operador confiar o desconfiar
de la tarjeta de un vistazo. Un ítem con todo `parsed` se revisa distinto que uno
con tres campos `assumed`.

---

## 4. El agente de pedidos (slot filling)

Un agente nuevo en `ai-api` (o un modo del agente actual) con estas tools contra este
repo, en la misma línea que `/api/agent/quotes`:

| Tool | Para qué |
|---|---|
| `search_contacts` | ✅ ya existe (`/api/agent/contacts`) — identificar al cliente por teléfono/CUIT |
| `get_catalog` | ✅ ya existe (`/api/agent/catalog`) — validar que el producto exista |
| `create_order_draft` | 🆕 abre el borrador con lo que se entendió del primer mensaje |
| `update_order_draft` | 🆕 completa campos a medida que el cliente contesta |
| `get_order_draft` | 🆕 releer el estado (el hilo puede retomarse días después) |
| `submit_order_draft` | 🆕 lo marca `ready` — dispara el envío al inventario |
| `request_human` | 🆕 handoff explícito con motivo y resumen |
| `get_order_status` | 🆕 "¿cómo viene mi pedido?" — lee del inventario |

El comportamiento pedido —**"que la IA se encargue de consultar todo lo que hace
falta"**— es exactamente slot filling: el agente sabe qué campos necesita un ítem,
mira cuáles faltan y pregunta **solo esos**, agrupados, en lenguaje del cliente:

> Cliente: *"necesito 20 equipos negros con led blanco"*
> Bot: *"Perfecto, 20 unidades en negro con LED blanco. Me faltan dos datos:
> ¿grampa larga o corta? ¿y qué óptica, 15°, 30° o 60°?"*

Reglas que hacen que esto no sea insoportable:

- **Preguntar de a poco**: máximo 2 datos por mensaje. WhatsApp no es un formulario.
- **Usar el historial del cliente**: si siempre pide grampa larga, se propone
  ("¿te mando grampa larga como la última vez?") en vez de preguntar en frío. Se
  marca `assumed`, no `parsed`.
- **No inventar precios**. El bot arma la comanda; **no cotiza**. Precio y descuento
  quedan del lado humano hasta que haya una política escrita.
- **Confirmar antes de cerrar**: resumen del pedido completo y un "¿lo confirmo?".

---

## 5. Handoff a humano

El pedido explícito era: **"que pueda pasar a un humano si no entiende o por motivos
que después definimos"**. La mecánica ya existe (`setMode(conversation, 'human')` +
ruteo a departamento); lo que hay que definir son los disparadores. Propuesta de
arranque, todos configurables por tenant:

**Automáticos**
1. El cliente lo pide ("quiero hablar con alguien").
2. Dos vueltas seguidas sin poder completar el mismo campo.
3. Producto que no está en el catálogo → probable custom, sin BOM.
4. Cualquier mención de precio, descuento, plazo de pago o reclamo.
5. Cliente no identificado tras pedir el dato dos veces.
6. Confianza baja del parser sobre el mensaje completo.
7. Enojo o urgencia detectada en el tono.
8. El cliente manda audio, foto o PDF (por ahora; el bot no los procesa).

**Manuales**
9. Cualquier operador puede tomar la conversación desde el inbox en cualquier momento
   (ya funciona así hoy).

Cuando se dispara, tres cosas pasan juntas:
- La conversación pasa a `human` y se rutea al departamento **Pedidos**.
- El borrador queda en `needs_human` y **se muestra al lado del hilo**, con los campos
  faltantes resaltados y el motivo del handoff arriba.
- El bot avisa al cliente que sigue una persona (sin dejarlo colgado en silencio).

El operador completa el borrador desde el panel, lo confirma, y **el mismo botón que
usa el bot** lo manda al inventario. Un solo camino de salida.

> Nota: el auto-cierre de conversaciones a las 24hs (`/api/cron/auto-return-bot`)
> **no debe cerrar borradores**. Un pedido a medio armar sobrevive al cierre de la
> conversación y se retoma cuando el cliente vuelve a escribir.

---

## 6. Carga manual de la comanda

Pantalla nueva en el admin (`/admin/pedidos`), pensada para el que hoy escribe la
comanda de papel:

- Alta de pedido eligiendo cliente (autocomplete contra Alegra) o cliente nuevo suelto.
- Ítems con los mismos campos de la comanda: producto, grampa, LED, óptica, color,
  cantidad, otros. Selects poblados desde el catálogo, no texto libre.
- Origen del pedido (teléfono / presencial / stock / otro) — se guarda, sirve después
  para saber por dónde entran los pedidos de verdad.
- Duplicar un pedido anterior del mismo cliente (los repetidos son la mayoría).
- Confirmar → mismo `POST /pedidos` al inventario que usa el bot.

Es la pantalla que hay que construir **primero**, antes que el parser: define la
entidad, el contrato, y ya reemplaza el papel aunque el bot no exista todavía.

---

## 7. Contrato con el sistema de inventario

Va documentado en `MyD-Org/platform` (`contracts/crm-inventario-pedidos.md`) como
manda `AGENTS.md`. Esbozo para discutir:

**CRM → Inventario · `POST /api/pedidos`** (auth: HMAC, mismo patrón que `agent-token.ts`)
```json
{
  "external_id": "draft_01H...",
  "origin": "whatsapp",
  "customer": { "external_id": "alegra:1234", "name": "...", "phone": "..." },
  "items": [{
    "product": "PROY-30W", "quantity": 20,
    "specs": { "clamp": "larga", "led_color": "blanco", "optic": "30", "body_color": "negro", "other": "" }
  }],
  "delivery_date_estimate": "2026-09-05",
  "priority": "normal",
  "notes": "..."
}
```
Respuesta: `{ order_id, order_number, eta, status, missing_materials?: [...] }`

`external_id` es la clave de idempotencia — un reintento no puede duplicar un pedido.

**Inventario → CRM · `POST /api/inventory/webhooks/order-status`**
```json
{ "order_id": "...", "external_id": "...", "status": "en_taller",
  "invoice": { "number": "...", "pdf_url": "..." }, "occurred_at": "..." }
```
El CRM decide qué status notifica al cliente y con qué texto. **El inventario no
decide comunicación**: fuera de la ventana de 24hs hay que usar plantilla aprobada de
Meta, y eso solo lo sabe el CRM.

**CRM → Inventario · consultas**: `GET /api/pedidos?customer_external_id=` y
`GET /api/pedidos/{id}` — para el "¿cómo viene mi pedido?" del bot y para la ficha
del cliente.

Dos definiciones que hay que cerrar antes de escribir código:

- **Vocabulario de specs compartido.** `"larga"`/`"corta"`, los colores de LED y las
  ópticas tienen que ser los mismos strings en los dos sistemas, o el BOM no resuelve.
  Propuesta: el inventario expone `GET /api/specs` y el CRM lo cachea; así el catálogo
  de opciones tiene un solo dueño.
- **Quién identifica al cliente.** Propuesta: Alegra es la fuente de verdad
  (`alegra:<id>`), el CRM lo resuelve y el inventario lo guarda como id externo.

---

## 8. Fases revisadas (lado CRM)

### Fase 1 — la comanda existe en el sistema
1. Entidad borrador de pedido + pantalla `/admin/pedidos` (carga manual).
2. Contrato acordado y `POST /pedidos` contra el inventario.
3. Vocabulario de specs sincronizado.

**Resultado**: el papel desaparece aunque el bot todavía no exista.

### Fase 2 — el bot arma la comanda
4. Tools de borrador para el agente + prompt de slot filling.
5. Disparadores de handoff + panel del borrador al lado del hilo.
6. Métricas: % de pedidos que el bot cierra solo, motivo de cada handoff.

**Resultado**: los pedidos de WhatsApp entran solos; los raros caen en manos de una
persona con el trabajo ya medio hecho.

### Fase 3 — el círculo se cierra
7. Webhook de status + notificaciones al cliente (plantillas Meta para fuera de ventana).
8. Pedidos del cliente visibles en el portal y en la ficha del inbox.
9. Email como segundo canal de parseo.

---

## 9. Para definir con el equipo

Además de lo que ya lista la propuesta original:

- **¿Quién confirma un pedido armado por el bot?** ¿Siempre pasa por una persona
  antes de reservar MP, o hay clientes/productos de confianza que van derecho?
  (Recomendación: **siempre revisión humana al principio**, y se afloja con datos.)
- **¿El bot cotiza?** Hoy la propuesta dice que no. Si mañana sí, hace falta una
  política de precios y descuentos escrita, porque el bot la va a aplicar literal.
- **¿Qué hace el bot fuera del horario laboral?** ¿Sigue armando pedidos de noche y
  encola el handoff para la mañana? (`lib/schedule.ts` ya modela horario comercial.)
- **Audios y fotos**: llegan seguido por WhatsApp. ¿Fase 2 o handoff directo?
- **Cliente nuevo que nunca compró**: ¿el bot le arma el pedido igual o lo pasa
  directo a comercial para el alta?
