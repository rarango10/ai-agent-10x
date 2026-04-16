---
name: Agent current datetime context
overview: Dar al modelo la fecha/hora actual en cada turno (en la zona del perfil del usuario) para que pueda calcular diferencias respecto a `next_run_at` u otras fechas, sin depender de que el usuario pegue su reloj.
todos:
  - id: time-helper
    content: Añadir helper de formato fecha/hora (Intl + IANA tz + ISO UTC)
    status: completed
  - id: agent-input
    content: Extender AgentInput con userTimeZone opcional y resolver tz en runAgent/resumeAgent
    status: completed
  - id: batch-inject
    content: Prefijar HumanMessage nuevo en buildMessageBatchForInvoke (ambas ramas)
    status: completed
  - id: callers
    content: Pasar userTimeZone desde chat, telegram webhook y cron/execute
    status: completed
isProject: false
---

# Contexto de fecha/hora actual para el agente

## Problema

El modelo **no** tiene reloj propio. En la imagen, el agente acertó el `next_run_at` pero dijo que no podía calcular “cuánto falta” sin la hora actual.

Además, en [`packages/agent/src/graph.ts`](packages/agent/src/graph.ts), cuando ya hay checkpoint (`hasCheckpointMessages`), `buildMessageBatchForInvoke` **solo** añade `[new HumanMessage(input.message)]` (aprox. líneas 637–638). El `SystemMessage` con las instrucciones del usuario se guardó en el **primer** turno: **no se actualiza** en turnos siguientes. Por tanto, meter “la fecha actual” solo dentro de `systemPrompt` del primer mensaje **no** resuelve preguntas en el turno 2+.

## Enfoque recomendado

Inyectar en **cada** invocación de `runAgent` (y, si aplica, en `resumeAgent`) un bloque corto y **siempre fresco** con la hora de referencia, **sin** alterar el texto que se persiste en `agent_messages` para el usuario.

- **Persistencia**: seguir guardando en BD el mensaje del usuario tal cual (`addMessage(..., input.message)` ya ocurre antes del invoke; no cambiar ese argumento).
- **Solo para el LLM**: al construir el lote que recibe el grafo, usar un `HumanMessage` cuyo contenido sea `contextoTemporal + "\n\n" + input.message`, o bien añadir un `SystemMessage` breve **solo con la hora** inmediatamente antes del `HumanMessage` del usuario en ese turno.

Recomendación: **prefijar el `HumanMessage` del turno actual** con una línea fija y parseable, por ejemplo:

`[Contexto del servidor — hora del usuario (America/Bogota): 2026-04-15, 20:30:00 GMT-05:00 | UTC: 2026-04-16T01:30:00.000Z]`

Así el checkpoint de LangGraph refleja también el contexto temporal de cada pregunta (útil para depuración). Si prefieres no ensuciar el checkpoint, la alternativa equivalente es `return [new SystemMessage(reloj), new HumanMessage(input.message)]` en la rama con checkpoint.

## Zona horaria

Reutilizar **`profiles.timezone`** (misma fuente que ya usa `create_cronjob`). Opciones:

1. **Dentro de `runAgent`**: llamar a `getProfile(db, userId)` una vez por request y derivar `ianaTimeZone` (fallback `"UTC"` si viene vacío).
2. **O** añadir campo opcional `userTimeZone?: string` a `AgentInput` y rellenarlo en [`apps/web/src/app/api/chat/route.ts`](apps/web/src/app/api/chat/route.ts), webhook de Telegram y [`apps/web/src/app/api/cron/execute/route.ts`](apps/web/src/app/api/cron/execute/route.ts) donde ya lees el perfil, para evitar un `getProfile` extra en el paquete agent.

Cualquiera es válida; (2) evita duplicar consultas en rutas que ya cargan perfil.

## Formato de hora

Implementar un helper pequeño (p. ej. en `packages/agent/src/time-context.ts` o al inicio de `graph.ts`) con **`Intl.DateTimeFormat`** y `timeZone: ianaTimeZone` (sin dependencias nuevas). Incluir siempre **ISO en UTC** además del formato local para cálculos inequívocos frente a `next_run_at` en UTC.

## Dónde tocar el código

| Archivo | Cambio |
|---------|--------|
| [`packages/agent/src/graph.ts`](packages/agent/src/graph.ts) | Función `buildClockPrefix(timeZone: string): string` (o similar). En `buildMessageBatchForInvoke`, en **ambas** ramas (con y sin checkpoint), envolver el contenido del último `HumanMessage` del batch con el prefijo **solo** para el mensaje **nuevo** del usuario (no reescribir historial cargado desde BD). |
| [`packages/agent/src/graph.ts`](packages/agent/src/graph.ts) | `AgentInput`: opcional `userTimeZone?: string`. Al inicio de `runAgent`/`resumeAgent`, resolver `tz = input.userTimeZone ?? (await getProfile(...)).timezone ?? 'UTC'`. |
| [`apps/web/src/app/api/chat/route.ts`](apps/web/src/app/api/chat/route.ts) (y Telegram / cron) | Pasar `userTimeZone: profile?.timezone` al llamar `runAgent` / `resumeAgent` cuando ya tengas el perfil. |

**`resumeAgent`**: tras HITL el usuario no envía un mensaje nuevo largo; igual conviene inyectar reloj en el batch que reanuda el grafo si en ese camino se añade contenido al modelo (revisar si `Command({ resume })` solo reanuda sin nuevo `HumanMessage`; si no hay nuevo human, puede no hacer falta cambio, o un reloj en el primer mensaje tras resume según el flujo interno de LangGraph).

## Nota sobre “próxima tarea programada”

Con el reloj resuelto, el modelo puede restar si **ya tiene** `next_run_at` en el contexto (p. ej. respuesta previa de `create_cronjob`). Si en un hilo **no** aparece ese dato, seguirá haci falta una tool tipo **`list_my_cronjobs`** o que el usuario repita el dato; eso puede ser un **siguiente** incremento, no bloqueante para “saber la fecha actual”.

## Prueba manual

1. Crear un cron, luego en **otro** mensaje preguntar “¿cuánto falta para la próxima ejecución?”.
2. Verificar que la respuesta usa la hora del prefijo y el `next_run_at` conocido, sin pedir la hora al usuario.
