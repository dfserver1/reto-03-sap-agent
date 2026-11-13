# Conocimiento del proceso — Órdenes de compra

## 1. Para qué sirve este documento

Este es el conocimiento de negocio que el agente consulta antes de actuar. Describe el proceso de compra de Periferia IT Group, las reglas de control RC1–RC10, el tratamiento de excepciones y el payload que se envía al SAP simulado. La ejecución vive en `src/tools/oc.ts` y en `src/lib/`; este documento explica el **por qué** y el **qué**, no reemplaza el código.

## 2. Actores

| Actor | Rol |
|---|---|
| Solicitante | Pide la compra y envía el paquete por correo. No usa el agente. |
| Líder aprobador | Responde "Aprobado" al correo. No usa el agente. |
| Analista administrativa | Usa el chat, revisa excepciones y confirma. |
| Contabilidad / Auditoría | Consume `out/control.csv` y la evidencia. |
| SAP | Sistema de registro; en el reto está simulado por archivos. |

## 3. Paquete de entrada

Cada caso vive en `fixtures/reto-03/solicitudes/<caso>/`:

| Archivo | Contenido | Obligatorio |
|---|---|---|
| `correo.json` | `id`, `de`, `para`, `asunto`, `fecha`, `cuerpo`, `adjuntos[]` | Sí |
| `solicitud.json` | Datos normalizados del Excel de solicitud | Sí |
| `cotizacion.txt` | Texto de la cotización: proveedor, NIT, ítems, subtotal, IVA, total, validez | No |
| `aprobacion.json` | Correo de aprobación: `de`, `para`, `fecha`, `asunto`, `cuerpo` | No |
| `factura.txt` | Factura; solo en casos retroactivos | No |

Un adjunto ausente se reporta como `null`; no se inventa. Un JSON malformado o un monto no numérico se devuelve como `{ ok: false, error }` legible.

### Paquete normalizado

```ts
type Paquete = {
  correo: { id, de, asunto, fecha }
  solicitud: {
    solicitud_id, solicitante, proveedor_nombre, proveedor_nit?,
    descripcion, centro_costo, subarea, cantidad, valor_unitario,
    valor_total, moneda, indicador_iva?, condiciones_pago?, fecha_solicitud
  }
  cotizacion: { proveedor, nit, total, moneda, validez_hasta, texto } | null
  aprobacion: { de, fecha, aprobado, texto } | null
  factura: { numero, fecha, total } | null
}
```

## 4. Reglas de control RC1–RC10

| # | Regla | Tipo | Cómo se resuelve |
|---|---|---|---|
| **RC1** | El proveedor debe existir en `proveedores.json` (por NIT; si no hay NIT, por nombre normalizado) y estar `activo`. | Bloqueo | Alta o reactivación en SAP. |
| **RC2** | La aprobación debe existir, contener "Aprobado" y venir de un correo listado como aprobador del `centro_costo`. | Bloqueo | Pedir la aprobación del líder correcto. |
| **RC3** | `valor_total` ≤ `tope` del aprobador para ese centro. | Bloqueo | Escalar a un aprobador de mayor nivel. |
| **RC4** | `subarea` debe pertenecer al `centro_costo`. | Bloqueo | Corregir centro o subárea. |
| **RC5** | `abs(cotizacion.total − solicitud.valor_total) / solicitud.valor_total` ≤ 2 %. Si excede: confirmación con ambos valores. Si no hay cotización: confirmación. | Confirmación | Mostrar ambos valores y pedir confirmación. |
| **RC6** | `indicador_iva` ausente → se deriva del proveedor (`indicador_iva_default`) y se pide confirmación. | Confirmación + derivado | Confirmar el código propuesto. |
| **RC7** | `condiciones_pago` ausente → se deriva del proveedor. Solo se informa. | Derivado | Informar el código derivado. |
| **RC8** | Existe `factura` con `fecha` < `fecha_solicitud` → `retroactiva = true`. Confirmación. Se registra en control. | Confirmación | Confirmar y marcar la OC como retroactiva. |
| **RC9** | La fecha de aprobación debe ser ≥ `fecha_solicitud`. Si no: confirmación. | Confirmación | Confirmar la validez de la evidencia. |
| **RC10** | `cantidad × valor_unitario` debe igualar `valor_total` (± 1 unidad monetaria). Si no: bloqueo. | Bloqueo | Corregir la solicitud. |

### Precedencia de datos

- Si un dato viene informado y es válido, se respeta.
- Si viene informado y no existe en el maestro, se bloquea; no se "corrige" en silencio.
- Si falta, se usa el default del proveedor y se informa. RC6 además exige confirmación; RC7 solo se informa.

### NIT

Los maestros traen el NIT base de 9 dígitos. Las cotizaciones pueden traer `900.555.111-2` (base + dígito de verificación). La comparación se hace sobre la base. En producción se validaría el DV con el algoritmo DIAN; en los fixtures los DV son ilustrativos y no cumplen el algoritmo, por eso la demo no los valida matemáticamente.

## 5. Confirmaciones y bloqueos

- **Bloqueo:** impide crear la OC. El agente explica el código, el mensaje y la acción sugerida. No hay payload ni creación.
- **Confirmación:** la solicitud es apta, pero un valor exige decisión humana. El agente muestra el valor de la solicitud, el valor de la cotización/factura/maestro y el impacto. Solo crea la OC después de una confirmación explícita.
- **Derivado:** el agente completa un valor desde el maestro (por ejemplo, condición de pago) y lo informa en la respuesta y en el payload.

## 6. Compra retroactiva

Una compra es retroactiva cuando existe una factura con fecha **anterior** a la fecha de la solicitud. También es una señal de alerta si la factura es anterior a la aprobación o si la aprobación es posterior a la factura.

Qué hace el agente:

1. Detecta la factura y compara fechas.
2. Marca `retroactiva = true`.
3. Pide confirmación humana con la fecha de la factura, la fecha de la solicitud y los días de diferencia.
4. Si se confirma, crea la OC y deja la marca `retroactiva = true` en `out/control.csv` y en las excepciones del payload.
5. No "normaliza" la excepción: queda registrada para auditoría.

Qué significa para el negocio:

- La compañía comprometió el gasto antes de la autorización formal.
- Se pierde poder de negociación y se puede pagar de más.
- Es un indicador de *maverick buying*, compras divididas o fraude con proveedor.
- La factura ya existe; el control preventivo (no PO, no pay) debe vivir en el proceso, no solo en el agente.

## 7. Payload de la OC (sección 7.4 del PRD)

```ts
type OrdenCompra = {
  referencia: { solicitud_id, correo_id, cotizacion_ref }
  sociedad: "1000"
  organizacion_compras: "1000"
  proveedor: { codigo_sap, nit, nombre }
  moneda: "COP" | "USD"
  condiciones_pago: string
  aprobador: { email, fecha_aprobacion, evidencia_sha256 }
  posiciones: [{
    numero, descripcion, cantidad, unidad, precio_unitario,
    centro_costo, subarea, indicador_iva
  }]
  excepciones: [{ codigo, detalle, confirmado_por }]
}
```

Reglas del payload:

- `descripcion` máximo 40 caracteres (texto breve SAP).
- `unidad`: `UN` para unidades, `H` para horas, `MES` para servicios mensuales.
- `evidencia_sha256` es el sha256 del texto de aprobación (encabezados + cuerpo), no del archivo completo.
- Los montos y el proveedor salen de la solicitud y de los maestros; nunca del modelo.
- Si la cotización difiere, la OC se construye con el valor de la **solicitud** y la discrepancia queda como excepción confirmada. No se cambia el valor aprobado por el líder.

## 8. Evidencia y log

- `out/<caso>/aprobacion.txt`: encabezados `De`, `Para`, `Fecha`, `Asunto`, cuerpo y `SHA256`.
- `out/<caso>/aprobacion.pdf`: opcional (P1), mismo contenido.
- `out/<caso>/trazabilidad.json`: origen de cada valor del payload.
- `out/sap/ordenes.jsonl`: una línea por OC creada, con número, fecha y payload.
- `out/control.csv`: una fila por intento, con `solicitud_id`, `resultado`, `numero_oc`, `retroactiva`, `bloqueos`, `confirmaciones` y `ts`.
- `out/log.jsonl`: todas las llamadas a herramientas.

## 9. Guía de los seis casos

| Caso | Situación | Resultado esperado |
|---|---|---|
| `sol-001` | Proveedor activo, aprobación válida, cotización coherente. | OC creada sin intervención. |
| `sol-002` | Proveedor inexistente en el maestro. | Bloqueo RC1; no se crea OC. |
| `sol-003` | Aprueba un líder de otro centro de costo. | Bloqueo RC2; no se crea OC. |
| `sol-004` | Cotización 26.500.000 vs solicitud 25.000.000 (6 %). | Confirmación RC5; OC solo con confirmación. |
| `sol-005` | Factura 2026-08-10 anterior a la solicitud 2026-08-27. | Confirmación RC8; OC marcada retroactiva. |
| `sol-006` | Faltan NIT, IVA y condición de pago. | Proveedor por nombre; IVA C1 confirmado; pago Z030 derivado; OC con confirmación. |

## 10. Glosario

- **OC:** orden de compra.
- **RC:** regla de control del PRD.
- **HITL:** human-in-the-loop; confirmación humana explícita.
- **Maestro:** archivo de referencia (proveedores, centros de costo, IVA, condiciones de pago).
- **OC retroactiva:** OC creada después de que ya existe una factura.
- **Split purchasing:** dividir una compra para evadir un tope de aprobación.
