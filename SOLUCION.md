# SOLUCIÓN — Reto 03: Agente conversacional de Órdenes de Compra SAP

> **Demo pública:** <https://practice-lexmark-acre-define.trycloudflare.com>
> **Repositorio/entrega:** carpeta `reto-03-sap-agent` (zip sin `node_modules`, `out/`, `.env` ni artefactos de build).
> **Nota de transparencia:** la instancia pública se levantó sin `GEMINI_API_KEY`, así que corre con el adaptador determinista (`/api/health` → `provider: "mock"`). El adaptador Gemini está implementado y se activa con la variable de entorno; el demo `npm run demo` no consume LLM por diseño. Ver sección 4.

---

## 1. El problema en una frase y a quién le duele

**En una frase:** la analista administrativa recibe por correo un paquete de compra y lo transcribe a SAP; cuando el proveedor no existe, el aprobador no corresponde al centro de costo, la cotización no cuadra o la factura ya existe, el error se descubre tarde y genera reprocesos, pagos sin OC o hallazgos de auditoría.

**A quién le duele:**

| Actor | Dolor actual | Qué cambia con el agente |
|---|---|---|
| Analista administrativa | Copia y pega datos de correos, PDFs y Excel; valida de memoria; persigue aprobaciones. | Recibe un paquete validado, con payload listo y excepciones explicadas; solo confirma. |
| Líder aprobador | Le llegan solicitudes incompletas o de otro centro de costo. | La aprobación se verifica contra el maestro antes de crear la OC. |
| Contabilidad / Tesorería | Paga facturas sin OC o con valores distintos a la solicitud. | `out/control.csv` y la evidencia dejan rastro; las diferencias se confirman. |
| Auditoría | No puede reconstruir por qué se creó una OC. | `trazabilidad.json` + `aprobacion.txt` + log de tool calls. |
| Compras | Compras retroactivas y proveedores informales. | La retroactividad se marca y se decide con el humano, no se oculta. |

El objetivo no es “un chat que escribe en SAP”, sino **un control de compras conversacional**: el agente automatiza lo repetitivo y escala lo que requiere criterio.

---

## 2. Arquitectura

### 2.1 Vista general

```mermaid
flowchart LR
  U[Analista] -->|chat| F[React + Vite]
  F -->|POST /api/chat| B[Express]
  B --> O[Orquestador]
  O -->|ruta determinista| T[Herramientas oc_*]
  O -->|si hay GEMINI_API_KEY| G[Gemini 3+ / 4 Flash (gemini-4-hydrogen)]
  G -->|function calls| T
  T --> X[fixtures/reto-03]
  T --> C[RC1–RC10]
  C --> P[Payload + trazabilidad]
  P --> E[Evidencia TXT/PDF]
  P --> S[SapAdapter / SapMock]
  S --> OUT[out/]
```

**Backend y frontend separados.** El backend es Express + TypeScript; el frontend es React + Vite. En desarrollo Vite corre en `5173` y hace proxy de `/api` a `3001`; en producción `Express` sirve `public/` y expone la API. No hay Next.js ni acoplamiento del prompt al frontend.

### 2.2 Las tres piezas que el PRD exige separadas

| Pieza | Archivo | Qué contiene | Qué **no** hace |
|---|---|---|---|
| **Prompt** | `agent/prompt.md` | Rol, reglas de oro, secuencia de herramientas, política de confirmación, prohibición de inventar datos y de alterar el payload. | No contiene reglas de negocio ejecutables ni montos. |
| **Conocimiento** | `src/knowledge/ordenes-compra.md` | Proceso, actores, RC1–RC10, payload, tratamiento de excepciones y retroactivas. | No reemplaza al código; explica el *por qué*. |
| **Ejecución** | `src/tools/oc.ts` + `src/lib/` | Esquemas Zod, validación, reconstrucción del payload, hash, evidencia, SAP mock. | No depende del prompt para decidir; el servidor es la fuente de verdad. |

El módulo portátil `modulo/` reexporta exactamente las mismas piezas:

- `modulo/agent.md`: prompt con frontmatter.
- `modulo/skill/ordenes-compra/SKILL.md`: conocimiento con frontmatter.
- `modulo/tools/oc.ts`: `export * from "../../src/tools/oc";` (no es una copia divergente).

### 2.3 Flujo de una solicitud

1. **Lectura:** `oc_leer_paquete({ caso })` normaliza correo, solicitud, cotización, aprobación y factura. Un adjunto opcional ausente se devuelve como `null` y se lista en `faltantes`; no se lanza una excepción.
2. **Validación:** `oc_validar({ caso, paquete })` relee el fixture (no confía en el paquete que envía el modelo), aplica RC1–RC10 y devuelve `apta`, `bloqueos`, `confirmaciones`, `derivados` y `retroactiva`.
3. **Payload:** si `apta=true`, `oc_construir_payload` arma la `OrdenCompra`, valida con Zod, calcula el hash de la aprobación y escribe `out/<caso>/trazabilidad.json`.
4. **Evidencia:** `oc_generar_evidencia` escribe `aprobacion.txt` (P0) y `aprobacion.pdf` (P1), con SHA-256 del contenido.
5. **Creación:** `oc_crear` compara el payload recibido con el canónico reconstruido (hash canónico), verifica bloqueos y confirmaciones, busca idempotencia por `solicitud_id` y crea la OC en el SAP simulado.
6. **Auditoría:** cada intento escribe una fila en `out/control.csv`; cada tool call se registra en `out/log.jsonl`; las órdenes van a `out/sap/ordenes.jsonl`.

### 2.4 Estructura de código

```text
src/
├─ agent/loop.ts          # runTurn, ruta determinista, ciclo LLM, confirmaciones
├─ lib/
│  ├─ controls.ts         # RC1–RC10
│  ├─ payload.ts          # construcción + trazabilidad
│  ├─ evidence.ts         # TXT/PDF + sha256 + OUT_DIR
│  ├─ audit.ts            # control.csv, log.jsonl, ordenes.jsonl
│  ├─ fixtures.ts         # lectura/normalización de casos
│  ├─ maestros.ts         # proveedores, centros, IVA, condiciones
│  ├─ normalize.ts        # moneda, fechas, NIT, nombre, unidad
│  └─ session.ts          # sesiones en memoria, pending, tokens
├─ llm/
│  ├─ adapter.ts          # interfaz LlmAdapter + LlmUsage
│  ├─ gemini.ts           # fetch a Gemini 3+/4 (gemini-4-hydrogen), function calling, usage, autodetección
│  └─ mock.ts             # fallback determinista
├─ sap/
│  ├─ adapter.ts          # interfaz SapAdapter (contrato del PRD)
│  └─ mock.ts             # SapMock: JSONL + numeración 4500000001+
├─ tools/oc.ts            # Zod + las 5 herramientas P0
├─ types/domain.ts
└─ server.ts              # Express + API + estáticos
```

---

## 3. El ciclo del agente

### 3.1 Entrada y ruteo

`runTurn(sesion, mensaje, ctx, adapter)` hace:

1. Agrega el mensaje del usuario a la sesión.
2. Si hay `sesion.pending`, entra en **modo confirmación** y no deja que el modelo decida: `manejarConfirmacionPendiente`.
3. Si el mensaje menciona un caso (`sol-001`…`sol-006`), entra al pipeline del caso.
4. Si no, responde ayuda y recuerda los casos disponibles.

Esto evita el fallo clásico de “el modelo ve una confirmación y decide crearla”: la confirmación es un **estado del servidor**, no una sugerencia del prompt.

### 3.2 Ruta determinista

Es la ruta que usa `demo.ts` y el fallback cuando no hay LLM. Ejecuta la misma secuencia de herramientas, sin modelo:

```text
oc_leer_paquete
  → oc_validar
  → si hay bloqueos: responder y no crear
  → si hay confirmaciones: dejar pending y pedir confirmación
  → oc_construir_payload
  → oc_generar_evidencia
  → oc_crear
```

Ventajas: reproducible, barata, testeable y sin alucinación. No es un “modo de mentira”: es el **camino de control** que también usa el LLM a través de las herramientas.

### 3.3 Ciclo con LLM (Gemini)

Si `GEMINI_API_KEY` está definida y `LLM_PROVIDER=gemini`:

1. Se construyen las definiciones de herramientas con `zodToJsonSchema` (helper `convertirAJsonSchema` para evitar el tipo recursivo de Zod).
2. Se llama a Gemini con `systemInstruction`, historial y `functionDeclarations`.
3. El modelo devuelve `functionCall(s)`; el backend valida argumentos con Zod y ejecuta `callTool`.
4. El resultado se devuelve como `functionResponse` en un mensaje `tool`; el ciclo continúa.
5. Tope: `MAX_ITERACIONES_TOOL` (25), `MAX_TOKENS_SESION` (60.000), `MAX_TOKENS_SALIDA` (2.048), timeout de 30 s.
6. Si el modelo no llama herramientas en el primer turno, se usa la ruta determinista; si Gemini falla, se responde con un error legible y la sesión queda utilizable.

**Guarda de confirmación:** antes de ejecutar cualquier `oc_crear` pedido por el modelo, el orquestador fuerza `confirmado=false`. La única ruta que pasa `confirmado=true` es `manejarConfirmacionPendiente`, después de que el usuario responde afirmativamente. Así, un modelo comprometido o alucinado no puede saltarse la confirmación humana.

**Tope de tokens:** el adaptador Gemini lee `usageMetadata` y acumula `tokensUsados` en la sesión. Al superar `MAX_TOKENS_SESION`, el agente se detiene con un mensaje claro. El frontend muestra el consumo en la respuesta (`tokensUsados`).

### 3.4 Confirmaciones humanas

| Estado | Qué pasa | Qué ve el usuario |
|---|---|---|
| `apta=false` | Hay bloqueos; no se construye payload ni se crea. | Lista de bloqueos con regla, mensaje y acción sugerida. |
| `apta=true`, sin confirmaciones | Se construye, evidencia y crea. | “OC creada”, número, payload y evidencia. |
| `apta=true`, con confirmaciones | Se construye, evidencia y **se deja pendiente**. No se llama `oc_crear`. | Banner “Confirmación humana requerida”, detalle y botón. |
| Usuario dice `confirmo` | `manejarConfirmacionPendiente` llama `oc_crear({ confirmado:true })`. | OC creada o error, y fila `CREADA`/`BLOQUEADA` en control. |
| Usuario dice `no` / `rechazo` | Se limpia el pendiente; no se crea. | “No se creó ninguna OC.” |
| Respuesta ambigua | Se repite la pregunta. | El pendiente sigue vivo. |

Códigos que generan confirmación: `RC5` (diferencia/no cotización), `RC6` (IVA faltante derivado), `RC8` (retroactiva), `RC9` (aprobación anterior a la solicitud). Los bloqueos (`RC1`, `RC2`, `RC3`, `RC4`, `RC7` inválido, `RC10`) no se pueden confirmar: primero se corrige el dato.

### 3.5 Idempotencia

`oc_crear` hace, en orden:

1. Valida el payload con Zod.
2. Relee el fixture y reconstruye la validación y el payload canónico.
3. Compara el payload recibido con el canónico usando `jsonCanonico` + SHA-256; si difiere, `PAYLOAD_ALTERADO`.
4. Si hay bloqueos, `BLOQUEADA`.
5. Si hay confirmaciones y `confirmado !== true`, `CONFIRMACION_REQUERIDA` y fila `PENDIENTE_CONFIRMACION`.
6. Busca una OC existente por `solicitud_id` (`SapAdapter.buscarOrdenPorReferencia`); si existe, devuelve `{ numero_oc, fecha original, idempotente: true }` y registra `CREADA` sin duplicar.
7. Si no existe, `SapMock.crearOrden` asigna el siguiente número y escribe `out/sap/ordenes.jsonl`.

El demo ejecuta `sol-001` dos veces y verifica que el número no cambia. La limitación de concurrencia del mock se discute en la sección 12.

---

## 4. Elección del modelo

### 4.1 Modelo

**Gemini 4 Hydrogen** (`gemini-4-hydrogen`) — modelo generalista vigente de Google (Gemini 3+/4) — vía API REST de Google AI Studio, sin SDK: `fetch` nativo de Node 20+.

**Por qué:**

- Soporta **function calling** nativo con firma de pensamiento multi-turno, que es la pieza central del reto.
- Español correcto y buen seguimiento de instrucciones estructuradas.
- Costo moderado (US$1,50 entrada / US$7,50 salida por millón de tokens) y *thinking* configurable (`low` por defecto).
- Contexto amplio (1M tokens) para el prompt + conocimiento + paquete + resultados de herramientas.
- Sin dependencia de un SDK pesado; el adaptador son ~180 líneas.

**Configuración:** `maxOutputTokens=2048`, `thinkingConfig.thinkingLevel=low` (sin `temperature`, `topP`, `topK` ni `thinkingBudget`), timeout 30 s, `usageMetadata` para el presupuesto, `id` y `thoughtSignature` en `functionCall`/`functionResponse`.

### 4.2 Costo estimado

Precios de lista de referencia (verificar en la consola de Google al momento de la defensa):

| Concepto | Estimado |
|---|---|
| Entrada | US$1,50 por millón de tokens |
| Salida | US$7,50 por millón de tokens |
| Prompt + conocimiento | ~3.500 tokens |
| Un caso con 5 tool calls y 1 turno | ~12.000–20.000 input + ~1.500–2.500 output |
| **Costo por caso** | **≈ US$0,03–0,05** |
| Caso con confirmación (2 turnos) | ≈ US$0,05–0,08 |
| Los 6 casos | < US$0,30 |
| `npm run demo` (determinista) | **US$0** |

El tope `MAX_TOKENS_SESION=60000` acota el peor caso: aunque el modelo entre en bucle, no puede gastar sin límite. `MAX_ITERACIONES_TOOL=25` acota el número de llamadas.

### 4.3 Fallback y transparencia

- Si no hay `GEMINI_API_KEY`, el servidor arranca con `MockAdapter` y la ruta determinista. El chat, las herramientas, las confirmaciones y el SAP simulado funcionan igual; solo no hay razonamiento libre del modelo.
- Si Gemini devuelve error, timeout o bloqueo, el orquestador responde con el error y no crea nada. No se “inventa” una respuesta.
- La clave se lee **solo** de `process.env`; no se escribe en `out/`, no se envía al frontend y no se registra en logs. `/api/health` solo devuelve el nombre del proveedor y el modelo.
- La instancia pública de esta entrega no tiene la clave; el `README` y esta sección lo dicen explícitamente. Para la defensa con LLM: definir `GEMINI_API_KEY` y reiniciar el servidor/túnel.

---

## 5. Matriz de controles RC1–RC10

La validación vive en `src/lib/controls.ts`. `apta = bloqueos.length === 0`; las confirmaciones no vuelven “no apta” la solicitud, pero impiden crear hasta que el humano confirme.

| Regla | Qué verifica | Implementación | Tipo | Caso que la ejercita |
|---|---|---|---|---|
| **RC1** | Proveedor existe y está activo | Busca por NIT base o nombre normalizado en `proveedores.json`; si no existe o está inactivo → bloqueo. | Bloqueo | `sol-002` (proveedor inexistente) |
| **RC2** | Aprobación explícita del líder autorizado del centro de costo | `aprobacion.aprobado === true`, remitente en `centro.aprobadores`; si no → bloqueo. | Bloqueo | `sol-003` (`fvargas` es de `CC-3030`, no de `CC-2020`) |
| **RC3** | Valor dentro del tope del aprobador | `valor_total <= aprobador.tope`; si excede → bloqueo. | Bloqueo | No aparece en los 6; los valores están bajo el tope |
| **RC4** | Subárea pertenece al centro de costo | Compara `solicitud.subarea` contra `centro.subareas`; si no → bloqueo. | Bloqueo | No aparece en los 6 |
| **RC5** | Coherencia cotización vs solicitud | NIT base, proveedor, moneda, total > 0 y diferencia ≤ 2 %. Diferencia > 2 % o falta de cotización → confirmación. NIT o moneda incompatibles → bloqueo de integridad. | Confirmación / bloqueo extra | `sol-004` (6 %) |
| **RC6** | IVA informado o derivado | Si viene, debe existir en `indicadores-iva.json`; si falta, usa el default del proveedor y **confirma**; si no hay default, bloquea. | Derivación + confirmación | `sol-006` (propone `C1`) |
| **RC7** | Condición de pago informada o derivada | Si viene, debe existir; si falta, usa el default del proveedor (sin confirmación); si no hay default, bloquea. | Derivación | `sol-006` (deriva `Z030`) |
| **RC8** | Compra retroactiva | Si hay factura con fecha anterior a la solicitud → `retroactiva=true` + confirmación. | Confirmación + bandera | `sol-005` (17 días antes) |
| **RC9** | Aprobación no anterior a la solicitud | Compara fechas date-only; si la aprobación es anterior → confirmación. | Confirmación | No aparece en los 6 |
| **RC10** | Coherencia cantidad × valor unitario vs total | `abs(cantidad * valor_unitario - valor_total) <= 1`; si no → bloqueo. | Bloqueo | No aparece en los 6 |

**Controles extra de integridad** (documentados como endurecimiento, no como RC nuevos):

- NIT de cotización distinto al de la solicitud/proveedor → bloqueo (no se puede crear una OC con la cotización de otro proveedor).
- Moneda de cotización distinta → bloqueo.
- Total de cotización ilegible/≤ 0 → confirmación.
- Fecha de factura ilegible → confirmación.
- Proveedor de cotización sin NIT y nombre distinto → confirmación.

**El control más difícil: RC5.** Combina varias cosas: parsear el texto libre de la cotización, comparar NIT por base de 9 dígitos (los fixtures traen DV y el DV no cumple DIAN), normalizar nombres con sufijos (`S.A.S.`, `Ltda.`), validar moneda y aplicar una tolerancia del 2 %. Además, la decisión correcta no es “usar la cotización”: se usa el **valor de la solicitud** y la diferencia se eleva como excepción. En `sol-004` la cotización es `26.500.000`, la solicitud `25.000.000`; la OC se crea por `25.000.000` y el 6 % queda en `excepciones[RC5]`. El segundo más difícil es **RC8**, porque exige comparar fechas date-only, marcar `retroactiva` en el payload y en `control.csv`, y no confundir la fecha de la factura con la de la solicitud.

---

## 6. Diseño del adaptador SAP real

### 6.1 Contrato

`src/sap/adapter.ts` define exactamente:

```ts
export interface SapAdapter {
  consultarProveedor(
    nit: string,
  ): Promise<{ codigo_sap: string; activo: boolean } | null>;
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>;
  buscarOrdenPorReferencia(
    solicitud_id: string,
  ): Promise<{ numero_oc: string } | null>;
}
```

`SapMock` implementa el contrato con archivos. Para producción, `SapODataAdapter` implementaría el mismo contrato; el resto del agente no cambia.

### 6.2 Opción recomendada: OData `API_PURCHASEORDER_PROCESS_SRV` (S/4HANA)

**Por qué:** es la API estándar de órdenes de compra en S/4HANA, expone `A_PurchaseOrder` y `A_PurchaseOrderItem`, se consume por HTTPS y no requiere instalar un cliente RFC/JCo en Node. Es más portable que `BAPI_PO_CREATE1` (RFC) y más gobernable que automatizar SAP GUI.

**Flujo:**

1. **Proveedor:** `GET /sap/opu/odata/sap/API_BUSINESS_PARTNER/A_Supplier?$filter=Supplier eq '...'` o el maestro de proveedores de compras; verificar `Supplier` y bloqueo de compra. El contrato devuelve `codigo_sap` y `activo`.
2. **Idempotencia:** `GET /sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder?$filter=YY1_EXT_REF eq '<solicitud_id>'&$select=PurchaseOrder`. Si existe, devolver el número. Si no existe un campo custom, crear una tabla de correlación en la capa de integración (o usar `PurchaseOrderType` + referencia externa). **No** confiar en que SAP asigne un número nuevo sin consultar: el mock lo hace por archivo, pero el adaptador real debe ser idempotente por `solicitud_id`.
3. **Crear:** `POST /A_PurchaseOrder` con un payload que incluya la cabecera y `to_PurchaseOrderItem`. Usar `$batch` con un *changeset* para que cabecera e ítems sean atómicos; si el API no lo permite, crear cabecera y luego ítems, y compensar/consultar por `YY1_EXT_REF` si falla un ítem.
4. **Respuesta:** `PurchaseOrder` y `CreationDate`; mapear a `{ numero_oc, fecha }`.
5. **Errores:** distinguir 4xx de datos (no reintentar) de 5xx/timeout (reintentar con backoff exponencial y idempotencia). Si hay error parcial, consultar por la referencia externa y marcar para reconciliación; no crear una segunda OC.

**Mapeo de campos:**

| Payload del agente | SAP OData | Nota |
|---|---|---|
| `sociedad` (`PERF`) | `CompanyCode` | Configurar en el adaptador, no en el prompt. |
| `organizacion_compras` (`PC01`) | `PurchasingOrganization` | Idem. |
| `proveedor.codigo_sap` | `Supplier` | Debe ser el código SAP, no el NIT. |
| `moneda` | `DocumentCurrency` | `COP`/`USD`. |
| `condiciones_pago` | `PaymentTerms` | `Z000`, `Z015`, `Z030`, `Z060`. |
| `posiciones[].descripcion` | `PurchaseOrderItemText` | Máx. 40 en el payload; SAP permite más, pero el contrato del reto lo limita. |
| `posiciones[].cantidad` | `OrderQuantity` | Decimal según unidad. |
| `posiciones[].unidad` | `PurchaseOrderQuantityUnit` | Mapear `UN`→`EA`, `H`→`H`, `MES`→`MON` (según configuración). |
| `posiciones[].precio_unitario` | `NetPriceAmount` | Sin IVA; el IVA va por `TaxCode`. |
| `posiciones[].centro_costo` | `CostCenter` | Derivar sociedad/área. |
| `posiciones[].subarea` | `CostCenter`/`WBSElement`/campo custom | Según el modelo de datos del cliente. |
| `posiciones[].indicador_iva` | `TaxCode` | `C1` etc.; validar contra el maestro de impuestos. |
| `referencia.solicitud_id` | Campo custom `YY1_EXT_REF` o tabla de correlación | Clave de idempotencia. |
| `aprobador` / evidencia | Adjunto o campo custom | Guardar hash y URL/objeto; no el binario en SAP si no está permitido. |
| `excepciones` / `retroactiva` | Texto de cabecera / campo custom | Para auditoría y reportería. |

**Autenticación y secretos:**

- OAuth 2.0 client credentials contra SAP IAS/XSUAA, o *principal propagation* si el cliente lo exige. El token se pide al servidor de identidad y se cachea hasta su expiración.
- Para SAP on-premise, exponer la API a través de **SAP Cloud Connector** o un API Gateway; no abrir el puerto RFC a internet.
- Credenciales en un vault (Azure Key Vault, AWS Secrets Manager, HashiCorp Vault) e inyección en runtime; rotación y mínimo privilegio (solo crear OC, consultar proveedor y leer OC).
- mTLS/allowlist de IP si el cliente lo requiere. Todo el tráfico por HTTPS; no loguear tokens ni payloads con PII.

### 6.3 Plan B si no hay OData

1. **BAPI `BAPI_PO_CREATE1` por RFC:** requiere SAP NetWeaver, usuario técnico y un cliente RFC (JCo para Node o un microservicio Java/.NET). Es más invasivo y difícil de desplegar, pero funciona en ECC sin OData.
2. **Archivo de carga / LSMW / Fiori “Manage Purchase Orders”:** el agente genera un CSV/Excel o un JSON listo para pegar; el humano carga. Menos automático, pero útil si el cliente no expone APIs.
3. **SAP GUI Scripting:** última opción; frágil, dependiente de la versión y de la pantalla; no recomendado para producción.
4. **Modo dry-run:** el adaptador devuelve un número simulado y el payload; el humano valida antes de habilitar escritura. Útil para el *rollout*.

### 6.4 Errores parciales y consistencia

- Usar `$batch` con changeset para que cabecera e ítems sean una unidad; si no, tratar la creación como saga: cabecera → ítems → confirmación; si falla un ítem, consultar por `YY1_EXT_REF`, bloquear la OC y registrar la compensación.
- No reintentar un `POST` sin idempotencia: primero consultar por la referencia externa.
- Guardar el `request-id`/`correlation-id` en `out/log.jsonl` para soporte.
- Si SAP devuelve un número pero el commit es incierto, consultar por la referencia antes de responder al usuario.

---

## 7. Lectura del proceso: compras retroactivas

### 7.1 Qué son

Una compra es **retroactiva** cuando la factura (o el bien/servicio) existe antes de la solicitud de compra y, por tanto, antes de la OC. En el kit, `sol-005` tiene factura `FC-88231` del **2026-08-10** y solicitud del **2026-08-27**: 17 días de retroactividad.

### 7.2 Cómo lo trata el agente

- `RC8` compara la fecha de la factura con la fecha de la solicitud (date-only).
- Si la factura es anterior: `retroactiva=true`, se agrega una **confirmación** (no un bloqueo automático) y se explica el número de días.
- La OC se crea con `retroactiva: true` y la fila de `out/control.csv` también queda con `retroactiva=true`.
- El humano decide si la evidencia es suficiente. El agente no oculta ni “normaliza” la fecha.

### 7.3 Qué significa para el negocio

- **Riesgo de control:** se comprometió un gasto sin OC; puede haber pagos sin contrato, fraccionamiento o proveedores no homologados.
- **Riesgo financiero:** la factura puede tener un valor distinto al de la solicitud; el agente ya eleva `RC5` si la cotización no cuadra.
- **Riesgo de auditoría:** sin una marca explícita, la retroactividad se pierde en el correo. El `control.csv` y la trazabilidad la conservan.

### 7.4 Recomendación de proceso (no solo técnica)

1. **Política:** definir un umbral (por ejemplo, tolerar retroactivas < 30 días con aprobación del líder y marca; bloquear > 30 días o reincidentes).
2. **“No PO, no pay”:** si no hay OC, la factura no se paga salvo excepción aprobada; el agente puede generar la OC retroactiva con evidencia, pero tesorería necesita la marca.
3. **Pre-check en recepción de factura:** integrar el número de solicitud/OC en la recepción; si no existe, alertar antes del pago.
4. **Métrica:** reportar % de compras retroactivas por centro, proveedor y comprador; si sube, investigar.
5. **Automatización:** si la factura llega antes, el agente puede abrir la solicitud con el paquete completo y pedir la aprobación; el objetivo es reducir el tiempo entre necesidad y OC, no solo documentar el atraso.
6. **Proveedor:** una retroactiva repetida con el mismo proveedor puede indicar compras fuera de proceso; incluir en el scorecard.

---

## 8. Decisiones y trade-offs

| Decisión | Por qué | Trade-off / límite |
|---|---|---|
| **Node + Express + Vite/React**, no Next.js | Backend y frontend separados, API explícita, escritura de `out/` sencilla, despliegue Docker directo. | Sin SSR ni edge; el frontend es una SPA. Para este reto, la API y la auditabilidad pesan más. |
| **Ruta determinista + Gemini opcional** | El demo debe ser reproducible y no depender de una clave; el LLM aporta conversación y manejo de lenguaje natural. | Hay que mantener dos rutas; la determinista no “razona” fuera de los casos. El LLM path usa las mismas herramientas, así que la lógica no se duplica. |
| **SAP simulado con archivos** | `out/control.csv`, `ordenes.jsonl` y `log.jsonl` son auditables, fáciles de inspeccionar y de testear. | Sin transacciones ni concurrencia real; la idempotencia es por archivo. En producción se reemplaza por el adaptador OData y una base/cola. |
| **Reconstruir el payload en el servidor y comparar hash** | El modelo no es la fuente de verdad; un payload alterado se rechaza. | Más I/O y un paso extra; el modelo debe pasar exactamente el payload devuelto. Es el precio de la seguridad. |
| **Esquema laxo para `paquete`/`derivados` en las herramientas + relectura del fixture** | Evita que el LLM tenga que reproducir un JSON gigante y reduce errores de argumentos; el servidor relee la fuente. | El esquema de esos argumentos no valida cada campo; la validación fuerte está en el fixture y en `OrdenCompraSchema`. Documentado y probado. |
| **NIT por base de 9 dígitos, sin validar DV** | Los DV de los fixtures no cumplen el algoritmo DIAN; validarlos rompería el kit. | En producción se debe validar el DV y usar el maestro de proveedores como fuente. |
| **Una posición por solicitud** | Los 6 casos tienen una sola línea; el payload y la UI se mantienen simples. | El contrato permite `posiciones[]`; el constructor actual arma una. Para múltiples líneas hay que mapear ítems de cotización y totales. |
| **Sesiones en memoria** | Simple, sin dependencias, suficiente para la demo y el túnel. | Se pierden al reiniciar; en serverless no hay *sticky sessions*. Producción: Redis/DB con TTL. |
| **Confirmaciones como estado del servidor, no del prompt** | Evita que el modelo se auto-confirme; la única ruta con `confirmado=true` es el turno humano. | Requiere que el cliente mantenga el `sessionId`; si se pierde, hay que repetir el caso. |
| **Vercel como opcional y Docker/Render/túnel como principal** | Vercel tiene filesystem efímero y sesiones por instancia; el túnel/Docker conservan el estado y el `out/`. | El túnel depende de que la máquina esté encendida; Render/Docker requieren una cuenta. La documentación da las tres opciones. |

---

## 9. Supuestos

1. Los fixtures son la fuente de verdad y están completos; no se modificaron.
2. El correo de aprobación con la palabra “Aprobado” es evidencia suficiente para el reto. En producción se requiere firma/SSO/SAP workflow.
3. El tope del aprobador se interpreta en la moneda de la solicitud; los fixtures son COP. No hay conversión FX implementada.
4. El NIT se compara por base de 9 dígitos; el DV no se valida porque los fixtures no lo cumplen.
5. Las solicitudes tienen una sola posición. El esquema permite varias, pero el constructor arma una.
6. La unidad (`UN`, `H`, `MES`) se infiere de la descripción y la cantidad (`inferirUnidad`); no viene en los fixtures.
7. `factura.txt` solo existe en casos retroactivos; su ausencia no es un “faltante”.
8. `aprobacion.json` puede faltar; se reporta `null` y RC2 bloquea. `correo.json` y `solicitud.json` son obligatorios.
9. Las fechas se comparan como date-only (`YYYY-MM-DD`); las fechas ISO con hora se recortan.
10. El IVA y la condición de pago se derivan del proveedor cuando faltan; el IVA derivado siempre se confirma, la condición de pago no.
11. La sesión y el `out/` son locales; en Vercel el `out/` va a `/tmp/out` y es efímero.
12. La demo pública puede correr en modo determinista si no hay clave; el adaptador Gemini es el camino de producción.
13. No hay autenticación de usuarios: cualquiera con la URL puede usar el chat. Es una demo, no un sistema multiusuario.
14. Los datos son ficticios; no hay PII real en los fixtures.

---

## 10. Cobertura contra las historias de usuario

| HU / requisito | Estado | Evidencia | Brecha para producción |
|---|---|---|---|
| **HU-1** Leer paquete y reportar adjuntos faltantes | Hecho (P0) | `oc_leer_paquete`, `faltantes`, `null` para cotización/aprobación/factura; no lanza excepción. | Parseo real de PDF/Excel; `oc_leer_excel` es P1 y no se implementó. |
| **HU-2** Validar contra maestros RC1–RC10 | Hecho | `src/lib/controls.ts`, 6 casos, matriz de la sección 5. | DV, FX, multi-posición, reglas configurables por cliente. |
| **HU-3** Construir payload y trazabilidad | Hecho | `oc_construir_payload`, `OrdenCompraSchema`, `trazabilidad.json`. | Mapeo a SAP real; campos custom. |
| **HU-4** Evidencia de aprobación | Hecho P0 + P1 | `aprobacion.txt`, `aprobacion.pdf`, SHA-256. | Firma electrónica, almacenamiento inmutable (S3/Object Lock), retención. |
| **HU-5** Crear OC idempotente y auditar | Hecho en mock | `oc_crear`, `buscarOrdenPorReferencia`, `control.csv`, `ordenes.jsonl`. | Idempotencia transaccional en SAP, cola, locks, reconciliación. |
| **HU-6** Errores legibles | Hecho | `{ok:false,error,codigo}`, JSON malformado → 400, timeout Gemini, límites. | Observabilidad, rate limiting, alertas. |
| **Frontend de chat** | Hecho | React, tool calls, banner de confirmación, payload, evidencia, control. | Auth, accesibilidad avanzada, i18n, tests E2E automatizados. |
| **Conexión a LLM** | Implementada | `GeminiAdapter`, function calling, autodetección/fallback de modelo, usage, thinking level, timeout, presupuesto. | La instancia pública actual no tiene clave; activar con `GEMINI_API_KEY`. |
| **Módulo portátil** | Hecho | `modulo/agent.md`, `modulo/skill/...`, `modulo/tools/oc.ts` (reexport). | Empaquetado como plugin/skill del cliente. |
| **`oc_leer_excel` (P1)** | No hecho | El kit entrega JSON/texto; el PRD lo marca P1 opcional. | Añadir `xlsx`/`exceljs` y un esquema de columnas. |
| **PDF de evidencia (P1)** | Hecho | `pdf-lib`, `aprobacion.pdf`. | Plantilla corporativa, firma, sello de tiempo. |
| **Demo determinista 6 casos** | Hecho | `npm run demo`: 6/6 PASS, 4 OC, 10 filas. | Casos adicionales de regresión. |
| **URL pública** | Hecho (túnel) | `https://practice-lexmark-acre-define.trycloudflare.com`. | Hosting permanente con Docker/Render; el túnel depende de la máquina. |

---

## 11. Uso de IA

**Asistentes usados:** OpenCode con el modelo **DeepSeek V4.1 Flash** como asistente de construcción; **Gemini 4 Hydrogen (`gemini-4-hydrogen`) es el modelo del agente en producción.

**Para qué se usó el asistente de construcción:**

- Scaffolding del proyecto Node/Express/React/Vite y de los archivos de configuración.
- Redacción inicial de adaptadores (`GeminiAdapter`, `SapMock`), UI y documentación.
- Revisión de tipos, detección de casos borde y generación de pruebas.
- Redacción de este documento y del README.

**Qué se descartó y por qué:**

- **Next.js:** el PRD pide backend y frontend separados y una ruta `src/tools/oc.ts`; Express + Vite es más directo y deja el `out/` en disco.
- **Validar el dígito de verificación del NIT:** los DV de los fixtures no cumplen el algoritmo DIAN; validarlo rompería los casos. Se documenta como brecha de producción.
- **Confiar en el `paquete` que envía el modelo:** se releyó el fixture y se reconstruye el payload; el modelo no es la fuente de verdad.
- **Usar solo el LLM:** se agregó la ruta determinista para que el demo sea reproducible y para que la app siga funcionando sin clave o si Gemini falla.
- **Aceptar `confirmado=true` del modelo:** se fuerza `false` en el ciclo LLM; la confirmación solo la procesa el servidor después del mensaje humano.

**Cómo se verificó:**

- `npm run typecheck` (backend + frontend + api) sin errores.
- `npm run demo` → 6/6 PASS, idempotencia, 4 OC, 10 filas.
- `npm run build` → Vite + tsc.
- Pruebas de API: health, cases, chat, confirmación, bloqueo, JSON malformado (400), sesión, evidencia.
- Prueba de interfaz en Chrome headless con Playwright: 6 casos, banner RC5, creación, bloqueo RC1, tool calls y control; **0 errores de consola**.
- Prueba del túnel público: health, HTML, `sol-006` con RC6 y confirmación → OC creada.

**Transparencia:** la instancia pública de esta entrega se desplegó sin clave de Gemini; el modo determinista es el fallback documentado. La clave no se incluye en el repositorio. Para la defensa con el modelo, definir `GEMINI_API_KEY` en el entorno y reiniciar.

---

## 12. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación implementada | Qué falta para producción |
|---|---|---|---|
| **Prompt injection** en correo/cotización | El modelo podría obedecer instrucciones del texto y intentar crear/alterar una OC. | El prompt trata los datos como datos; las herramientas releen el fixture; no hay shell; `oc_crear` reconstruye y compara hash; confirmación humana. | Clasificador de entrada, allowlist de dominios, aislamiento, monitoreo de respuestas, pruebas de red team. |
| **Alucinación de montos/NIT/fechas** | OC incorrecta o pago indebido. | Valores solo desde herramientas; payload canónico + hash; Zod; no se acepta payload del modelo sin comparar. | Validación maestro a maestro, doble control en SAP, muestreo humano. |
| **Aprobación falsificada** | Se crea una OC sin aprobación real. | RC2 valida remitente contra el centro; RC9 valida fecha; evidencia con hash. | Firma electrónica/SSO, DKIM/SPF, workflow de aprobación en SAP, verificación criptográfica. |
| **Idempotencia/concurrencia** | Dos requests simultáneos crean dos OC. | `buscarOrdenPorReferencia` antes de crear; demo secuencial. | Clave única en SAP/DB, lock por `solicitud_id`, cola, transacción, reconciliación. |
| **Error parcial de SAP** | Cabecera creada sin ítems o viceversa. | El mock es atómico por archivo. | `$batch`/changeset, saga con compensación, consulta por referencia, no reintentar a ciegas. |
| **Costo/abuso del LLM** | Consumo descontrolado de la clave. | `MAX_TOKENS_SESION`, `MAX_ITERACIONES_TOOL`, `MAX_TOKENS_SALIDA`, timeout, rate limit pendiente. | Rate limiting por usuario/IP, cuotas, presupuesto por tenant, alertas. |
| **Disponibilidad** | El túnel o el proceso local se cae. | Docker/Render/blueprint; fallback determinista; health check. | Hosting permanente, réplicas, monitoreo, SLO, backups. |
| **Datos personales** | Correos y nombres en logs/evidencia. | Fixtures ficticios; logs locales; no se envían claves. | Redacción de PII, cifrado, retención, control de acceso, DLP. |
| **Filesystem efímero en Vercel** | Se pierde `out/` y la sesión. | `OUT_DIR=/tmp/out`; se documenta Vercel como demo de una sesión. | S3/Blob/DB para evidencia; sesiones en Redis; no usar Vercel para confirmaciones críticas. |
| **NIT/DV, FX, multi-posición** | Datos reales que el mock no cubre. | Se documentan como supuestos/brechas. | Validar DV, tabla FX, múltiples ítems, impuestos por línea. |
| **Política de retroactivas** | Se normaliza una práctica riesgosa. | RC8 marca y pide confirmación; no oculta. | Política formal, umbral, aprobación de nivel, métricas y auditoría. |
| **Sobre-bloqueo por controles extra** | Un NIT de cotización distinto bloquea en vez de confirmar. | Se documenta como endurecimiento de integridad. | Parametrizar la política por cliente; permitir confirmación con aprobación superior si el negocio lo autoriza. |
| **Vendor lock-in del modelo** | Dependencia de Gemini. | Interfaz `LlmAdapter`; `MockAdapter`; el resto no conoce el proveedor. | Adaptador OpenAI/Anthropic/Azure; pruebas de contrato. |

---

## Apéndice A — Cómo verificar en 3 minutos

```bash
# 1. Tipos y demo determinista
npm run typecheck
npm run demo

# 2. Build y servidor
npm run build
npm start

# 3. API
curl.exe -s http://localhost:3001/api/health
curl.exe -s http://localhost:3001/api/cases

# 4. Confirmación RC5
curl.exe -s -X POST http://localhost:3001/api/chat ^
  -H "Content-Type: application/json" ^
  -d "{\"sessionId\":\"defensa\",\"message\":\"Procesa sol-004.\"}"

curl.exe -s -X POST http://localhost:3001/api/chat ^
  -H "Content-Type: application/json" ^
  -d "{\"sessionId\":\"defensa\",\"message\":\"confirmo\"}"

# 5. Evidencia
type out\control.csv
type out\sap\ordenes.jsonl
```

Salida esperada del demo: `Casos: 6/6 PASS, 0 FAIL`, `OC creadas: 4`, `Filas en out/control.csv: 10`, `Órdenes en out/sap/ordenes.jsonl: 4`.

**URL pública:** <https://practice-lexmark-acre-define.trycloudflare.com> (túnel Cloudflare; si no responde, ejecutar `npm run tunnel` y usar la nueva URL). El túnel apunta al servidor local en `3001`; para un despliegue permanente, usar Docker o Render.

## Apéndice B — Mapa de lectura para la defensa

Si te preguntan “explícame esta línea”, estos son los 10 archivos que conviene tener abiertos:

1. `src/lib/controls.ts` — RC1–RC10.
2. `src/tools/oc.ts` — contrato Zod, herramientas, hash del payload.
3. `src/agent/loop.ts` — ruta determinista, ciclo LLM, confirmaciones, tokens.
4. `src/lib/payload.ts` — construcción y trazabilidad.
5. `src/lib/evidence.ts` — TXT/PDF + SHA-256.
6. `src/lib/audit.ts` — control.csv, log.jsonl, ordenes.jsonl.
7. `src/sap/adapter.ts` + `src/sap/mock.ts` — contrato SAP.
8. `src/llm/gemini.ts` — function calling, usage, timeout.
9. `demo.ts` — los 6 casos, idempotencia y confirmación.
10. `web/src/App.tsx` — chat, tool calls, banner de confirmación, paneles.

**Frase de cierre:** el agente no reemplaza el criterio de la analista; le quita la transcripción y la obliga a decidir solo donde hay una excepción, con evidencia y trazabilidad.
