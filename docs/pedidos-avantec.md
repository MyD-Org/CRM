# Pedidos Avantec — parseo por IA sin tocar el CRM

> Documento complementario a *"Propuesta: Automatización del flujo de pedidos — Avantec"*
> (repo del sistema de inventario).
>
> **Decisión tomada: el módulo de pedidos se construye entero en el inventario.
> Este repo no cambia.** El agente arma la comanda con una tool nueva que apunta
> al inventario, y consume los endpoints `/api/agent/*` que el CRM ya expone.
>
> **Alcance del bot: armar pedidos nuevos y responder el estado de un pedido.**
> Reclamos, consultas técnicas y precios son handoff a un humano (ver §2 bis).
>
> Este doc vive acá porque documenta **qué le da hoy el CRM al agente**. El contrato
> definitivo entre proyectos va a `MyD-Org/platform` (`contracts/`), como manda `AGENTS.md`.

---

## 1. Reparto de responsabilidades

| Proyecto | Qué hace |
|---|---|
| **Inventario** | Módulo de pedidos, Kanban, **alta manual de comandas**, BOM, stock, facturación vía Alegra. Expone `POST /api/pedidos`, `GET /api/pedidos/{id}` y `GET /api/specs` |
| **ai-api** | La tool `crear_pedido`, el prompt de slot filling, la credencial contra el inventario |
| **CRM (este repo)** | **Nada nuevo.** Aporta lo que ya está: canal de WhatsApp, identificación del cliente, catálogo, handoff a humano |

El pedido —incluido el que carga administración por teléfono o por stock— vive en un
solo lugar: el inventario. No hay una segunda pantalla de alta de pedidos en el CRM.

---

## 2. Lo que el CRM ya le da al agente (no hay que construirlo)

Todo esto está en producción. El bot de WhatsApp lo puede usar **hoy**, sin cambios.

| Endpoint | Para qué en el flujo de pedidos |
|---|---|
| `GET /api/agent/contacts?q=` | Identificar al cliente en Alegra por nombre/CUIT |
| `GET /api/agent/catalog` | Validar que el producto exista antes de armar la comanda |
| `GET /api/agent/prices` | Precios por lista |
| `GET /api/agent/payment-conditions`, `/payment-terms` | Condiciones de pago |
| `GET /api/agent/sales-config` | Listas de precio, vendedores, impuestos |
| `GET /api/agent/invoices`, `/payments`, `/account-balance` | Cuenta corriente del cliente |

**Auth**: los endpoints de datos del tenant (`contacts`, `catalog`, `prices`,
`payment-*`, `sales-config`) aceptan `INTERNAL_SECRET` como Bearer, justamente para el
flujo de canales donde **no hay un cliente logueado** — que es el caso de WhatsApp.
Ver `src/lib/agent-auth.ts` (`authAgentTenantRequest`).

Los de cuenta corriente (`invoices`, `payments`, `account-balance`) exigen `crm_token`
de un cliente logueado: son del widget del portal, no del bot de WhatsApp.

### Handoff a humano: ya existe

No requiere código nuevo en ningún lado. La mecánica (modo `bot`/`human`, ruteo por
departamento, inbox del operador, copiloto, auto-cierre a las 24hs) está implementada
y en uso. **Se activa desde el prompt del agente**, no programando.

---

## 2 bis. Alcance del bot

Al cliente le escribe a Avantec por varios motivos: encargar algo, preguntar cómo viene
un pedido, consultar un dato técnico, reclamar. El bot atiende **dos** de esos: armar un
pedido nuevo y responder el estado de un pedido existente. El resto es handoff.

### Lo que es prompt y lo que es trabajo real

La distinción importa para planificar, porque las dos cosas tienen costos muy distintos:

| | Se define en | Costo de cambiarlo |
|---|---|---|
| **Qué intenciones atiende el bot** | Prompt del agente | Minutos, sin deploy. Se afloja o se cierra cuando quieras |
| **Qué es capaz de responder** | Tools disponibles | Requiere exponer el endpoint en el inventario |

El prompt decide si el bot **tiene permitido** contestar algo. La tool decide si **puede**.
Son independientes: un bot al que el prompt le permite responder el estado de un pedido,
pero que no tiene la tool para consultarlo, **inventa** — y eso es peor que derivar.

Por eso el estado de pedidos entra al alcance del inventario (`GET /api/pedidos`, §3): no
alcanza con permitirlo en el prompt.

### Clasificación de intención (primer paso de cada conversación)

| Intención | Quién atiende |
|---|---|
| Quiere encargar productos | **Bot** — arma la comanda |
| Estado de un pedido existente | **Bot** — lo consulta al inventario |
| Reclamo, garantía, devolución | Handoff |
| Consulta técnica del producto | Handoff |
| Precio, descuento, plazo de pago | Handoff |
| Saludo suelto / no se entiende | Handoff |

Sobre precios: por política, **por este canal no se habla de plata**. No es un caso
frecuente, pero la regla queda escrita porque el cliente igual puede preguntar, y la
respuesta tiene que ser siempre la misma (derivar, no improvisar un número).

Esta tabla vive en el prompt. Ampliarla o achicarla no requiere tocar código **mientras
la tool exista**; sumar una intención que necesite datos nuevos, sí.

### Casos límite (la parte que importa)

- **La intención cambia a mitad del pedido** (*"ah, y de paso, ¿el anterior está listo?"*)
  → el bot responde el estado y **retoma el pedido donde lo dejó**. Es el caso más común
  de todos y conviene probarlo explícitamente.
- **Pedido y precio juntos** (*"quiero 20 equipos, ¿cuánto salen?"*) → arma la comanda y
  deriva **solo** la parte del precio, sin abandonar el pedido.
- **Handoff sin cerrar el trabajo hecho**: cuando el bot deja la conversación con un
  pedido incompleto, su último paso es **resumir en el hilo lo recolectado hasta ahí**
  (cliente, ítems, specs confirmadas, qué falta). Como no hay borrador guardado en el
  CRM, ese resumen en la conversación *es* el traspaso. Sin él, el operador arranca de cero.

### Disparadores de handoff dentro de un pedido en curso

Aun cuando la intención es correcta, el bot se retira si:

1. El cliente pide hablar con una persona.
2. Dos vueltas seguidas sin poder completar el mismo dato.
3. El producto no está en el catálogo → probable custom, sin BOM.
4. El cliente no se puede identificar tras preguntar dos veces.
5. Llega un audio, una foto o un PDF (por ahora el bot no los procesa).
6. Hay enojo o urgencia en el tono.

---

## 3. Lo que tiene que exponer el inventario

### `GET /api/specs` — vocabulario de opciones válidas

**Es el endpoint más importante de los tres.** Sin él el modelo inventa valores
("óptica media", "led cálido", "grampa mediana") y el BOM no resuelve. Con él, la tool
valida contra la lista y el agente sabe exactamente qué preguntar.

```json
{
  "clamp":      { "label": "Grampa",      "options": ["larga", "corta"] },
  "led_color":  { "label": "Color de LED", "options": ["blanco", "calido", "neutro", "rgb"] },
  "optic":      { "label": "Óptica",       "options": ["15", "30", "60"] },
  "body_color": { "label": "Color del equipo", "options": ["negro", "blanco", "gris"] },
  "other":      { "label": "Otros", "free_text": true }
}
```

El inventario es el **dueño** de este vocabulario: agregar una óptica nueva se hace ahí
y el bot se entera solo. Los valores de acá tienen que ser exactamente los mismos
strings que usa el BOM.

### `POST /api/pedidos` — crear la comanda

Auth: API key server-to-server (mismo patrón que `INTERNAL_SECRET`).

```json
{
  "external_id": "wa_5493511234567_1755712800",
  "origin": "whatsapp",
  "customer": {
    "external_id": "alegra:1234",
    "name": "Iluminación del Centro SRL",
    "phone": "+5493511234567"
  },
  "items": [{
    "product": "PROY-30W",
    "product_external_id": "alegra:5678",
    "quantity": 20,
    "specs": {
      "clamp": "larga", "led_color": "blanco",
      "optic": "30", "body_color": "negro", "other": ""
    }
  }],
  "delivery_date_estimate": "2026-09-05",
  "priority": "normal",
  "notes": "Retira el jueves por la tarde",
  "source_conversation": "https://<crm>/admin/inbox/c/<end_user_id>"
}
```

Respuesta:
```json
{ "order_id": "...", "order_number": 142, "status": "recibido",
  "eta": "2026-09-05", "missing_materials": [] }
```

**`external_id` es clave de idempotencia y no es opcional.** El agente puede reintentar
una tool call —timeout, reintento del modelo, cliente que manda "sí" dos veces— y sin
esto aparecen dos comandas en el taller. El inventario debe devolver **el mismo pedido**
ante un `external_id` repetido, no crear uno nuevo ni tirar error.

`source_conversation` es el link al hilo en el inbox del CRM: cuando el del taller mira
una comanda rara, puede ir a leer qué dijo el cliente textualmente. Sale casi gratis y
vale mucho el día que el parser se equivoca.

### `GET /api/pedidos?customer_external_id=` y `GET /api/pedidos/{id}`

Para que el bot conteste *"¿cómo viene mi pedido?"* — la consulta más repetida después
del pedido en sí. Es de **solo lectura**: no puede romper nada, no dispara procesos, no
mueve stock. De los tres endpoints es el más barato de construir.

```json
{ "order_number": 142, "status": "en_taller",
  "eta": "2026-09-05", "updated_at": "2026-08-20T14:32:00Z" }
```

Dos cosas a definir acá, y las dos son de negocio, no técnicas:

- **Qué status ve el cliente.** Los internos del Kanban ("esperando MP") pueden no ser
  los que conviene mostrar. Recomendación: un mapa de status interno → texto al cliente,
  configurable en el inventario, para no atar el vocabulario del taller al del cliente.
- **Cómo se identifica quién pregunta.** Por WhatsApp el cliente está identificado por su
  teléfono, no por una sesión. Un pedido solo debe devolverse a quien lo hizo: el
  inventario tiene que filtrar por `customer_external_id`, nunca aceptar un número de
  pedido suelto sin validar de quién es.

---

## 4. La tool del agente (ai-api)

Se registra en `ai-api` junto a las que ya existen. Esbozo:

```json
{
  "name": "crear_pedido",
  "description": "Crea un pedido de fabricación en el sistema de inventario. Usar SOLO cuando todos los datos obligatorios de todos los ítems están completos y el cliente confirmó el resumen.",
  "input_schema": {
    "type": "object",
    "required": ["customer", "items"],
    "properties": {
      "customer": {
        "type": "object",
        "required": ["name", "phone"],
        "properties": {
          "external_id": { "type": "string", "description": "id de Alegra si se pudo identificar con la tool de contactos" },
          "name":  { "type": "string" },
          "phone": { "type": "string" }
        }
      },
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["product", "quantity", "specs"],
          "properties": {
            "product":  { "type": "string" },
            "quantity": { "type": "integer", "minimum": 1 },
            "specs": {
              "type": "object",
              "description": "Valores tomados de GET /api/specs. No inventar opciones."
            }
          }
        }
      },
      "delivery_date_estimate": { "type": "string" },
      "notes": { "type": "string" }
    }
  }
}
```

Y `consultar_pedido`, para el estado:

```json
{
  "name": "consultar_pedido",
  "description": "Consulta el estado de los pedidos del cliente con el que se está hablando. Usar cuando pregunta cómo viene un pedido. Devolver el status tal como viene, sin prometer fechas que no estén en la respuesta.",
  "input_schema": {
    "type": "object",
    "required": ["customer_external_id"],
    "properties": {
      "customer_external_id": { "type": "string" },
      "order_number": { "type": "integer", "description": "opcional; sin esto devuelve los pedidos abiertos del cliente" }
    }
  }
}
```

Más `consultar_specs` (o, más barato en tokens si las opciones cambian poco, el prompt
las inyecta ya resueltas).

Total: **una tool de escritura y dos de lectura.** Superficie chica y verificable.

Una regla para el prompt que vale la pena: *"si la tool no devuelve fecha de entrega, no
inventes una; decí que todavía no está confirmada"*. Es el error típico y el más caro,
porque el cliente después reclama por una fecha que nadie prometió.

### Comportamiento esperado: slot filling

El pedido *"que la IA se encargue de consultar todo lo que hace falta"* es esto: el
agente sabe qué campos necesita un ítem, mira cuáles faltan y pregunta **solo esos**.

> Cliente: *"necesito 20 equipos negros con led blanco"*
> Bot: *"Perfecto, 20 unidades en negro con LED blanco. Me faltan dos datos:
> ¿grampa larga o corta? ¿y qué óptica, 15°, 30° o 60°?"*

Reglas para que no sea insoportable:

- **Máximo 2 datos por mensaje.** WhatsApp no es un formulario.
- **Usar el historial**: si el cliente siempre pide grampa larga, proponer
  (*"¿te mando grampa larga como la última vez?"*) en vez de preguntar en frío.
- **No cotizar.** El bot arma la comanda; precio y descuento son handoff a humano
  hasta que exista una política escrita.
- **Confirmar antes de crear**: resumen completo y un "¿lo confirmo?" antes de llamar
  a `crear_pedido`. La tool se ejecuta una sola vez, al final.

---

## 5. Fuera de alcance por ahora

**Avisarle al cliente por WhatsApp cuando cambia el status del pedido.** Requiere salir
por la API de Meta, que la tienen el CRM y ai-api — no el inventario. Cuando se aborde,
la opción sana es que el inventario dispare un webhook y que el aviso salga por donde ya
salen los mensajes. Que el inventario mande WhatsApp por su cuenta sería un tercer lugar
con credenciales de Meta y con la lógica de la ventana de 24hs duplicada.

---

## 6. A definir con el equipo

- **¿Quién confirma un pedido armado por el bot?** ¿Entra directo al Kanban o cae en una
  bandeja de revisión? Recomendación: **revisión humana al principio**, y se afloja con datos.
- **¿El Kanban del inventario va a tener un status previo tipo "por revisar"?** Si no, cada
  charla que no termina en nada deja basura en el tablero del taller.
- **Cliente nuevo que nunca compró**: ¿el bot le arma el pedido igual, o lo pasa a
  comercial para el alta en Alegra?
- **Fuera de horario**: ¿el bot sigue armando pedidos de noche y encola el handoff para
  la mañana? (`src/lib/schedule.ts` ya modela el horario comercial del tenant.)
- **Productos custom**: los que no tienen BOM predefinido, ¿los toma el bot o son
  handoff directo?
- **¿Qué status ve el cliente?** Hace falta el mapa de status interno del Kanban → texto
  al cliente (ver §3).
- **¿Con qué criterio se amplía el alcance a consultas técnicas?** Es la única categoría
  grande que queda en handoff y no depende de datos nuevos, solo de prompt — o sea que se
  puede probar barato cuando haya ganas.
