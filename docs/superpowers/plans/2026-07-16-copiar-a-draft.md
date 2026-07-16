# Plan: "Copiar" del copilot pega en el draft + métrica de borradores

## Objetivo
Que el botón del copilot inserte la sugerencia directamente en el campo de redacción
del operador (en vez de solo copiar al portapapeles), y de paso registrar si el
operador la mandó tal cual o la editó. Esa métrica ("% enviado sin editar") es el
criterio para pasar de copilot → bot-first en ventas.

## Estado actual
- Panel del copilot: `src/components/admin/AiAssistPanel.tsx` (botón copiar).
- Vista del chat con el composer: `src/components/admin/ContactThreadView.tsx`.

## Pasos
1. **Insertar en draft**: levantar el estado del draft (o pasar un callback
   `onInsertDraft(text)`) de `ContactThreadView` a `AiAssistPanel`. El botón pasa a
   "Usar" → setea el draft con el texto de la sugerencia (reemplaza lo que haya,
   con foco en el textarea). Mantener "copiar al portapapeles" como acción secundaria.
2. **Marcar origen**: al insertar, guardar en un ref/estado `draftFromCopilot: string`
   (el texto original sugerido).
3. **Métrica al enviar**: si el mensaje enviado vino del copilot, comparar con el
   texto original → `sent_as_is` | `edited` (si `draftFromCopilot` es null → `manual`).
   Registrarlo donde sea más barato: campo `metadata` del mensaje saliente o un
   log/tabla simple `copilot_draft_events`.
4. **Ver la métrica**: por ahora alcanza una query SQL a mano (% as-is por semana).
   Panel en el admin: después, si hace falta.

## Criterio de graduación (decidido 2026-07-16)
Cuando ~80%+ de los borradores del copilot se envíen sin editar durante ~2 semanas,
activar bot-first en ventas (primero fuera de horario de atención, después siempre).
El takeover por conversación y el kill switch ya existen como escape.
