# Agente personal (MVP)

Monorepo con **Next.js**, **Supabase**, **LangGraph** y **OpenRouter**. Incluye chat web, onboarding, ajustes y bot de **Telegram** (opcional).

## Requisitos previos

- **Node.js** 20 o superior (recomendado LTS).
- **npm** 10+ (incluido con Node.js 20+).
- Cuenta en **[Supabase](https://supabase.com)** (gratis).
- Cuenta en **[OpenRouter](https://openrouter.ai)** para la API del modelo (clave de API).
- *(Opcional)* Bot de Telegram creado con [@BotFather](https://t.me/BotFather) y una URL **HTTPS** pública para el webhook (en local suele usarse **ngrok** o similar).

---

## Paso 1 — Clonar e instalar dependencias

1. Clona el repositorio y entra en su **raíz** (la carpeta que contiene el `package.json` del monorepo).

   ```bash
   git clone <URL_DEL_REPO> 10x-builders-agent
   cd 10x-builders-agent
   ```

2. Instala dependencias desde esa misma raíz (npm instala workspaces de `apps/*` y `packages/*`):

   ```bash
   npm install
   ```

---

## Paso 2 — Crear proyecto en Supabase

1. Entra en el [dashboard de Supabase](https://supabase.com/dashboard) y crea un **nuevo proyecto**.
2. Espera a que termine el aprovisionamiento.
3. En **Project Settings → API** anota:
   - **Project URL** → será `NEXT_PUBLIC_SUPABASE_URL`
   - **`anon` public** → será `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **`service_role` secret** → será `SUPABASE_SERVICE_ROLE_KEY` (no la expongas al cliente ni la subas a repositorios públicos).

---

## Paso 3 — Aplicar el esquema SQL (tablas + RLS)

1. En Supabase, abre **SQL Editor**.
2. Abre el archivo del repo:

   `packages/db/supabase/migrations/00001_initial_schema.sql`

3. Copia **todo** el contenido y pégalo en el editor.
4. Ejecuta el script (**Run**).

Si algo falla (por ejemplo, el trigger `on_auth_user_created` en un proyecto ya modificado), revisa el mensaje de error; en la mayoría de proyectos nuevos el script aplica de una vez.

5. Si el proyecto aún no las tiene, aplica también (en orden) los scripts en:

   - `packages/db/supabase/migrations/00002_tool_calls_lc_tool_call_id.sql`
   - `packages/db/supabase/migrations/00003_cronjobs.sql`

---

## Paso 4 — Configurar autenticación (email)

1. En Supabase: **Authentication → Providers** → habilita **Email** (por defecto suele estar activo).
2. **Authentication → URL configuration**:
   - **Site URL**: para desarrollo local usa `http://localhost:3000`
   - **Redirect URLs**: añade al menos:
     - `http://localhost:3000/auth/callback`
     - `http://localhost:3000/**` (o la variante que permita tu versión del dashboard para desarrollo)

Así el flujo de login/signup y el intercambio de código en `/auth/callback` funcionan en local.

---

## Paso 5 — Variables de entorno

Next.js carga `.env*` desde el directorio de la app **`apps/web`**, no desde la raíz del monorepo.

1. Desde la **raíz del repo** (donde está `.env.example`), copia el ejemplo:

   ```bash
   cp .env.example apps/web/.env.local
   ```

   *(Si ya tienes `.env.local` en la raíz, mueve o copia ese archivo a `apps/web/.env.local`.)*

2. Edita `apps/web/.env.local` y completa:

   | Variable | Descripción |
   |----------|-------------|
   | `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto Supabase |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Clave `anon` |
   | `SUPABASE_SERVICE_ROLE_KEY` | Clave `service_role` (solo servidor; la usa la API del agente y Telegram contra Postgres) |
   | `OPENROUTER_API_KEY` | Clave de OpenRouter |
   | `TELEGRAM_BOT_TOKEN` | *(Opcional)* Token del bot |
   | `TELEGRAM_WEBHOOK_SECRET` | *(Opcional)* Secreto que Telegram enviará en cabecera; debe coincidir con el configurado al registrar el webhook |
   | `OAUTH_ENCRYPTION_KEY` | Clave **AES-256** para cifrar tokens OAuth en base de datos. Debe ser **64 caracteres hexadecimales** (32 bytes), p. ej. salida de `openssl rand -hex 32` |
   | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | OAuth App de GitHub (ver abajo) |
   | `NEXT_PUBLIC_APP_URL` | URL base pública de la app (sin `/` final), p. ej. `http://localhost:3000` — usada para el callback de GitHub |
   | `CRON_SECRET` | *(Opcional)* Secreto compartido para `POST /api/cron/execute` (cabecera `x-cron-secret`). Necesario si usas tareas programadas con Supabase `pg_cron`, Vercel Cron u otro programador |

Referencia de nombres: [.env.example](.env.example).

### GitHub OAuth (integración)

1. En GitHub: **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. **Authorization callback URL**: `{NEXT_PUBLIC_APP_URL}/api/integrations/github/callback` (ej. `http://localhost:3000/api/integrations/github/callback`).
3. Copia **Client ID** y genera **Client secret** → `GITHUB_CLIENT_ID` y `GITHUB_CLIENT_SECRET` en `apps/web/.env.local`.
4. Scopes solicitados por la app: **`repo`** (repos privados, issues y creación de repositorios). El usuario los aprueba al conectar en **Ajustes**.

---

## Paso 6 — Arrancar la aplicación web

Desde la **raíz** del repo:

```bash
npm run dev
```

Por defecto Turbo ejecuta el `dev` de cada paquete; la app suele quedar en **http://localhost:3000**.

Flujo esperado:

1. **Registro** en `/signup` o **login** en `/login`.
2. **Onboarding** (perfil, agente, herramientas, revisión).
3. **Chat** en `/chat` y **ajustes** en `/settings`.

---

## Paso 7 — Probar el chat con el modelo

1. Confirma que `OPENROUTER_API_KEY` está en `apps/web/.env.local`.
2. En el onboarding, activa al menos las herramientas básicas (`get_user_preferences`, `list_enabled_tools`) si quieres probar *tool calling*.
3. Escribe un mensaje en `/chat`. Si la clave o el modelo fallan, revisa la consola del servidor (terminal donde corre `npm run dev`).

El modelo por defecto está definido en `packages/agent/src/model.ts` (OpenRouter, `openai/gpt-4o-mini`). Puedes cambiarlo ahí si lo necesitas.

---

## Paso 8 — Telegram (opcional)

Telegram **exige HTTPS** para webhooks. En local:

1. Crea el bot con BotFather y copia el token → `TELEGRAM_BOT_TOKEN` en `apps/web/.env.local`.
2. Elige un secreto aleatorio → `TELEGRAM_WEBHOOK_SECRET` (mismo valor usarás al registrar el webhook).
3. Expón tu app local con un túnel HTTPS, por ejemplo:

   ```bash
   ngrok http 3000
   ```

   Usa la URL HTTPS que te dé ngrok (p. ej. `https://abc123.ngrok-free.app`).

4. Con la app en marcha, visita en el navegador (sustituye la URL base):

   `https://TU_URL_NGROK/api/telegram/setup`

   Eso llama a `setWebhook` de Telegram apuntando a `/api/telegram/webhook` y, si definiste secreto, lo asocia al webhook.

5. En la web, entra a **Ajustes** → **Telegram** → **Generar código de vinculación**.
6. En Telegram, envía al bot: `/link TU_CODIGO` (el código que te muestra la web).

Después de vincular, los mensajes al bot usan el mismo pipeline que el chat web.

---

## Tareas programadas (cron) — opcional

El agente puede crear trabajos recurrentes con la herramienta `create_cronjob` (actívala en onboarding o en **Ajustes**). Las expresiones usan **5 campos** (minuto hora día mes día-semana), interpretadas en la **zona horaria del perfil** del usuario.

1. Aplica la migración `00003_cronjobs.sql` (ver Paso 3).
2. Define `CRON_SECRET` en `apps/web/.env.local` en desarrollo y el **mismo valor** en las variables de entorno de tu despliegue (p. ej. Vercel). Sin eso `/api/cron/execute` responde 503 o 401.
3. Elige cómo disparar cada minuto el endpoint (abajo, **opción A** recomendada si tu base ya está en Supabase).

4. **Telegram**: por defecto el resultado de cada ejecución se envía al chat vinculado (`[Tarea programada] {nombre} …`). Si el usuario no tiene Telegram vinculado, el job se ejecuta igual pero solo verás avisos en los logs del servidor.

### Opción A — Supabase (`pg_cron` + `pg_net`)

La app Next sigue desplegada donde la tengas (Vercel, etc.); solo el **reloj** vive en Postgres.

1. En Supabase: **Database → Extensions** activa **`pg_cron`** y **`pg_net`** (o ejecútalo en SQL Editor si tu proyecto lo permite):

   ```sql
   create extension if not exists pg_cron with schema extensions;
   create extension if not exists pg_net with schema extensions;
   ```

   Si el dashboard no deja crear la extensión, revisa la documentación actual de tu plan o pide habilitarlas al soporte.

2. Sustituye en el siguiente bloque:
   - `https://TU_DOMINIO_PUBLICO` — URL HTTPS donde corre **Next** (sin barra final), p. ej. `https://mi-app.vercel.app`
   - `TU_CRON_SECRET` — el **mismo** string que `CRON_SECRET` en el servidor de la app

3. En **SQL Editor**, ejecuta **una vez**:

   ```sql
   select cron.schedule(
     'execute-agent-cronjobs',
     '* * * * *',
     $$
     select net.http_post(
       url := 'https://TU_DOMINIO_PUBLICO/api/cron/execute',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-cron-secret', 'TU_CRON_SECRET'
       ),
       body := '{}'::jsonb
     );
     $$
   );
   ```

4. Comprueba que el job existe: `select * from cron.job;`   Para quitarlo y volver a crearlo: anota el `jobid` y ejecuta `select cron.unschedule(<jobid>);`.

5. **Seguridad**: el secreto queda en la definición del job en la base de datos; no lo compartas ni subas este SQL a un repo público con valores reales. Si cambias `CRON_SECRET` en la app, actualiza el job (unschedule + `schedule` de nuevo con el nuevo valor).

6. Si no ves peticiones llegar a tu app, revisa en Supabase **Database → Logs** o la cola de `pg_net` según la versión del proyecto; la URL del `net.http_post` debe ser alcanzable desde internet (no uses `http://localhost` ahí).

### App en local + Supabase en la nube (ngrok)

Es un escenario válido: **Postgres y `pg_cron` están en Supabase**; **Next corre en tu máquina** y solo necesitas una URL HTTPS pública hacia tu puerto local.

1. Arranca la app: `npm run dev` (deja el proceso en marcha mientras pruebes los cron).
2. En otra terminal: `ngrok http 3000` (o el puerto que use Next).
3. Copia la URL HTTPS que te da ngrok, p. ej. `https://abc123.ngrok-free.app` **sin barra final**.
4. En el `cron.schedule` de arriba, usa exactamente esa base como `https://TU_DOMINIO_PUBLICO` (sigue siendo `.../api/cron/execute`).
5. **`CRON_SECRET`** en `apps/web/.env.local` debe coincidir con el valor que pusiste en la cabecera `x-cron-secret` del job en Supabase.

**Importante:** con ngrok gratuito la URL suele **cambiar** cada vez que reinicias el túnel. Entonces debes **volver a programar el job** (`cron.unschedule` del id anterior y otro `cron.schedule` con la URL nueva), o usar un **dominio reservado** en ngrok para que la URL sea estable.

Mientras desarrollas en local, cualquier petición que Supabase dispare a ngrok solo llegará si **tu PC está encendida**, ngrok activo y `npm run dev` corriendo.

---

## Comandos útiles

| Comando | Descripción |
|---------|-------------|
| `npm run dev` | Desarrollo (monorepo) |
| `npm run build` | Build de todos los paquetes que definan `build` |
| `npm run lint` | Lint |
| `cd apps/web && npx next build` | Build solo de la app Next (útil para comprobar tipos antes de desplegar) |

---

## Documentación adicional

- [docs/brief.md](docs/brief.md) — visión y brief original.
- [docs/architecture.md](docs/architecture.md) — arquitectura técnica del MVP.
- [docs/plan.md](docs/plan.md) — fases y decisiones de implementación.

---

## Problemas frecuentes

- **Redirecciones infinitas o “no auth”**: revisa `Site URL` y `Redirect URLs` en Supabase y que `.env.local` esté en **`apps/web`**.
- **Errores al guardar perfil o mensajes**: confirma que ejecutaste la migración SQL y que RLS no bloquea por falta de sesión (debes estar logueado con el mismo usuario).
- **Chat sin respuesta / 500 en `/api/chat`**: `OPENROUTER_API_KEY`, cuota en OpenRouter o modelo en `model.ts`.
- **Telegram no responde**: webhook debe ser HTTPS; token y secreto correctos; visita de nuevo `/api/telegram/setup` si cambias la URL pública.

Si quieres, el siguiente paso natural es desplegar **Vercel** (o similar) para `apps/web`, definir las mismas variables de entorno en el panel del proveedor y usar la URL de producción en Supabase y en el webhook de Telegram.
