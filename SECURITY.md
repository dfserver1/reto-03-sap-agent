# Seguridad — Reto 03: Agente conversacional de Órdenes de Compra SAP

> **Alcance:** aplicación pública con enlace verificable durante la defensa técnica.
> El token del modelo (Gemini) vive **exclusivamente** en el backend y nunca sale del servidor.

## 1. Modelo de amenazas

| Amenaza | Mitigación aplicada |
|---|---|
| Fuga del token de Gemini al cliente | El token solo se lee de variables de entorno del backend (`GEMINI_API_KEY`); nunca se envía al front, nunca se registra y se redacta en logs, errores y evidencias. |
| Uso abusivo del token | Rate limit por IP (por defecto 120 req/min global y 12 chat/min), presupuesto diario de tokens (`MAX_TOKENS_DIA`, default 200 000), tope de tokens por sesión (`MAX_TOKENS_SESION`) y tope de herramientas por turno (`MAX_HERRAMIENTAS_POR_TURNO`). |
| Fuga por logs / errores / source maps | Redacción centralizada (`src/lib/redact.ts`), source maps desactivados, errores de servidor genéricos. |
| Prompt injection | El modelo no ejecuta comandos de shell; las herramientas re-leen los fixtures desde disco y validan con Zod; el payload se compara con hash canónico y se rechaza alteraciones. |
| Alteración de payloads | `oc_crear` compara el payload enviado contra el esperado con hash canónico (`jsonCanonico`) y rechaza diferencias. |
| Acceso no previsto a salidas | Rutas `out/*` con validación de caso (`sol-\d{3}`) y fuera del alcance de creación. |
| CSRF / origen cruzado | Middlewares de origen permitido (`APP_ORIGINS` + mismo host) para métodos de estado. |
| Recepción masiva de datos | `express.json({ limit: "256kb" })` y mensaje limitado a 8000 caracteres. |
| Ejecución arbitraria | Sin shell en herramientas; solo acceso a archivos del proyecto con validación de casos. |

## 2. Secretos

- Variables: `LLM_PROVIDER`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_MODEL_FALLBACKS`, `GEMINI_THINKING_LEVEL`, `GEMINI_MAX_OUTPUT_TOKENS`, `MAX_*`.
- `.env` no se incluye en el zip, en el build ni en el contenedor; `.env.example` documenta los nombres sin valores.
- `scripts/security-check.ts` (`npm run security:check`) escanea código fuente en busca de patrones de secretos, `any`, `@ts-ignore` y source maps.

## 3. Modelo de IA (Gemini vigente)

- No se asume Gemini 2.5 Flash: el adaptador (`src/llm/gemini.ts`) admite modelos Gemini 3+/4.
- Modelo recomendado: `gemini-4-hydrogen` (Gemini 4 Hydrogen, general-purpose, thinking `low|medium|high|xhigh`), con `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite` y `gemini-2.5-flash-lite` como alternativas.
- `GEMINI_MODEL=auto` (default) lista modelos disponibles vía `GET /v1beta/models` y elige el mejor candidato; `GEMINI_MODEL` fija uno y `GEMINI_MODEL_FALLBACKS` define la cadena de reintento.
- `GEMINI_THINKING_LEVEL=low` (budget de pensamiento); `GEMINI_MAX_OUTPUT_TOKENS` controla salida.
- El adaptador envía `generationConfig.maxOutputTokens` y `thinkingConfig.thinkingLevel`, sin parámetros deprecados (`temperature`, `topP`, `topK`) y sin presupuestos de pensamiento antiguos.
- Mantiene `id` en `functionCall`/`functionResponse` y firmas de pensamiento (`thoughtSignature`) para la continuidad multi-turno.
- Timeouts (30 s), reintentos con cambio de modelo solo para errores retryables (404/5xx/red) y errores sanitizados.

## 4. Endurecimiento HTTP

- Helmet con CSP estricta (`default-src 'self'`, sin `unsafe-inline` en script; `object-src 'none'`, `frame-ancestors 'none'`).
- `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP/COEP/CRP restringidos, `Cache-Control: no-store` en `/api`.
- Rate limit: global 120 req/min (`skip` en `/api/health`), chat 12 req/min.
- Límite de concurrencia de chats: `MAX_CONCURRENT_CHATS` (default 4).
- Body JSON máximo: 256 kb; mensaje máximo 8000 caracteres.
- Validación de origen para métodos de escritura (`POST/PUT/PATCH/DELETE`) con `APP_ORIGINS` opcional.
- Proxy confiable (`TRUST_PROXY`).

## 5. Sesiones y auditoría

- Sesiones con IDs validados (`/^[A-Za-z0-9_-]{3,64}$/`), máximo 50 por proceso.
- Auditoría en `out/control.csv`, `out/log.jsonl`, `out/sap/ordenes.jsonl`, evidencias en `out/<caso>/`.
- Registro de tool calls con argumentos y resultados redactados (`redactarJson`).

## 6. Producción recomendada

- Restringir la API key de Gemini en Google AI Studio (solo Generative Language API, restricciones de IP o usar Vertex AI).
- Reverse proxy / Cloudflare Access para limitar acceso a la URL pública.
- Despliegue en contenedor con filesystem escribible o túnel local; Vercel con `/tmp/out` y sesiones por instancia.
