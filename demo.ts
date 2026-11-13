import { callTool } from "./src/tools/oc";
import { leerControl, leerOrdenes, limpiarOut } from "./src/lib/audit";
import { CASOS } from "./src/lib/fixtures";
import type { OrdenCompra, Paquete, Validacion } from "./src/types/domain";

const directory = process.cwd();
const ctx = { directory, sessionId: "demo" };

interface Esperado {
  apta: boolean;
  bloqueo?: string;
  confirmacion?: string;
  retroactiva: boolean;
}

const ESPERADOS: Record<string, Esperado> = {
  "sol-001": { apta: true, retroactiva: false },
  "sol-002": { apta: false, bloqueo: "RC1", retroactiva: false },
  "sol-003": { apta: false, bloqueo: "RC2", retroactiva: false },
  "sol-004": { apta: true, confirmacion: "RC5", retroactiva: false },
  "sol-005": { apta: true, confirmacion: "RC8", retroactiva: true },
  "sol-006": { apta: true, confirmacion: "RC6", retroactiva: false },
};

async function main(): Promise<void> {
  console.log("========================================================");
  console.log(" RETO 03 — VERIFICACIÓN DETERMINISTA (sin modelo LLM)");
  console.log("========================================================");
  console.log(`Directorio: ${directory}`);
  console.log(`Casos: ${CASOS.length}`);
  console.log("");

  await limpiarOut(directory);

  let fallos = 0;

  for (const caso of CASOS) {
    try {
      await procesarCaso(caso);
    } catch (error) {
      fallos += 1;
      console.log(`[${caso}] FAIL`);
      console.log(`  ${(error as Error).message}`);
      console.log("");
    }
  }

  const control = await leerControl(directory);
  const ordenes = await leerOrdenes(directory);

  console.log("--------------------------------------------------------");
  console.log(" RESUMEN");
  console.log("--------------------------------------------------------");
  console.log(`Casos: ${CASOS.length - fallos}/${CASOS.length} PASS, ${fallos} FAIL`);
  console.log(`OC creadas: ${ordenes.length}`);
  console.log(`Filas en out/control.csv: ${control.length}`);
  console.log(`Órdenes en out/sap/ordenes.jsonl: ${ordenes.length}`);
  console.log("");
  console.log("Últimas filas de control:");
  for (const fila of control.slice(-10)) {
    console.log(
      `  ${fila.solicitud_id} | ${fila.resultado} | OC: ${
        fila.numero_oc || "—"
      } | retroactiva: ${fila.retroactiva} | bloqueos: ${
        fila.bloqueos || "—"
      } | confirmaciones: ${fila.confirmaciones || "—"}`,
    );
  }
  console.log("");
  console.log(fallos === 0 ? "RESULTADO: OK" : "RESULTADO: HAY FALLOS");
  process.exitCode = fallos === 0 ? 0 : 1;
}

async function procesarCaso(caso: string): Promise<void> {
  const esperado = ESPERADOS[caso];
  if (!esperado) throw new Error(`No hay resultado esperado para ${caso}.`);

  console.log(`[${caso}]`);
  const lectura = await callTool("oc_leer_paquete", { caso }, ctx);
  asegurar(lectura.parsed.ok, `No se pudo leer el paquete: ${textoError(lectura)}`);
  const paquete = lectura.parsed.data as Paquete;

  const validacionRes = await callTool("oc_validar", { caso, paquete }, ctx);
  asegurar(validacionRes.parsed.ok, `No se pudo validar: ${textoError(validacionRes)}`);
  const validacion = validacionRes.parsed.data as Validacion;

  const bloqueos = validacion.bloqueos.map((bloqueo) => bloqueo.codigo);
  const confirmaciones = validacion.confirmaciones.map((confirmacion) => confirmacion.codigo);

  console.log(`  apta: ${validacion.apta}`);
  console.log(`  bloqueos: ${bloqueos.length ? bloqueos.join(", ") : "(ninguno)"}`);
  console.log(
    `  confirmaciones: ${confirmaciones.length ? confirmaciones.join(", ") : "(ninguna)"}`,
  );
  console.log(`  retroactiva: ${validacion.retroactiva}`);

  asegurar(
    validacion.apta === esperado.apta,
    `Se esperaba apta=${esperado.apta} y se obtuvo ${validacion.apta}.`,
  );
  asegurar(
    validacion.retroactiva === esperado.retroactiva,
    `Se esperaba retroactiva=${esperado.retroactiva} y se obtuvo ${validacion.retroactiva}.`,
  );
  if (esperado.bloqueo) {
    asegurar(
      bloqueos.includes(esperado.bloqueo),
      `Se esperaba el bloqueo ${esperado.bloqueo} y se obtuvo ${bloqueos.join(", ") || "(ninguno)"}.`,
    );
    for (const bloqueo of validacion.bloqueos) {
      console.log(`    ${bloqueo.codigo}: ${bloqueo.mensaje}`);
      console.log(`      Acción: ${bloqueo.accion_sugerida}`);
    }
    asegurar(
      confirmaciones.length === 0,
      `Un caso bloqueado no debería tener confirmaciones: ${confirmaciones.join(", ")}.`,
    );
    console.log("  OC: no se crea (bloqueo).");
    console.log("");
    return;
  }

  if (esperado.confirmacion) {
    asegurar(
      confirmaciones.includes(esperado.confirmacion),
      `Se esperaba la confirmación ${esperado.confirmacion} y se obtuvo ${
        confirmaciones.join(", ") || "(ninguna)"
      }.`,
    );
  }

  const payloadRes = await callTool(
    "oc_construir_payload",
    { caso, paquete, derivados: validacion.derivados },
    ctx,
  );
  asegurar(payloadRes.parsed.ok, `No se pudo construir el payload: ${textoError(payloadRes)}`);
  const payloadData = payloadRes.parsed.data as {
    orden: OrdenCompra;
    trazabilidad_ruta: string;
  };
  const orden = payloadData.orden;

  asegurar(
    orden.posiciones[0].descripcion.length <= 40,
    "La descripción de la posición excede 40 caracteres.",
  );
  asegurar(
    orden.excepciones.length === validacion.confirmaciones.length,
    "Las excepciones del payload no coinciden con las confirmaciones.",
  );

  const evidenciaRes = await callTool("oc_generar_evidencia", { caso }, ctx);
  asegurar(evidenciaRes.parsed.ok, `No se pudo generar la evidencia: ${textoError(evidenciaRes)}`);
  const evidencia = evidenciaRes.parsed.data as { ruta: string; sha256: string };
  asegurar(
    orden.aprobador.evidencia_sha256 === evidencia.sha256,
    "El hash del payload no coincide con el sha256 de la evidencia.",
  );

  console.log(`  payload: ${orden.proveedor.nombre} | ${orden.referencia.solicitud_id}`);
  console.log(
    `  posición: ${orden.posiciones[0].cantidad} ${orden.posiciones[0].unidad} × ${orden.posiciones[0].precio_unitario} = ${
      orden.posiciones[0].cantidad * orden.posiciones[0].precio_unitario
    } ${orden.moneda}`,
  );
  console.log(`  trazabilidad: ${payloadData.trazabilidad_ruta}`);
  console.log(`  evidencia: ${evidencia.ruta} (sha256 ${evidencia.sha256.slice(0, 12)}…)`);

  if (validacion.confirmaciones.length > 0) {
    const sinConfirmar = await callTool("oc_crear", { caso, payload: orden }, ctx);
    asegurar(
      !sinConfirmar.parsed.ok,
      "La OC se creó sin confirmación pese a tener excepciones.",
    );
    asegurar(
      !sinConfirmar.parsed.ok && sinConfirmar.parsed.codigo === "CONFIRMACION_REQUERIDA",
      `Se esperaba CONFIRMACION_REQUERIDA y se obtuvo ${
        sinConfirmar.parsed.ok ? "ok" : sinConfirmar.parsed.codigo ?? "sin código"
      }.`,
    );
    console.log("  sin confirmación: PENDIENTE_CONFIRMACION (correcto)");

    for (const confirmacion of validacion.confirmaciones) {
      console.log(`    ${confirmacion.codigo}: ${confirmacion.mensaje}`);
    }

    const conConfirmar = await callTool(
      "oc_crear",
      { caso, payload: orden, confirmado: true },
      ctx,
    );
    asegurar(conConfirmar.parsed.ok, `No se pudo crear con confirmación: ${textoError(conConfirmar)}`);
    const creada = conConfirmar.parsed.data as {
      numero_oc: string;
      idempotente: boolean;
      retroactiva: boolean;
    };
    asegurar(!creada.idempotente, "La primera creación con confirmación no debe ser idempotente.");
    asegurar(
      creada.retroactiva === esperado.retroactiva,
      `La OC reportó retroactiva=${creada.retroactiva}.`,
    );
    console.log(`  OC: ${creada.numero_oc} | retroactiva: ${creada.retroactiva}`);
  } else {
    const creacion = await callTool("oc_crear", { caso, payload: orden }, ctx);
    asegurar(creacion.parsed.ok, `No se pudo crear la OC: ${textoError(creacion)}`);
    const creada = creacion.parsed.data as {
      numero_oc: string;
      idempotente: boolean;
      retroactiva: boolean;
    };
    asegurar(!creada.idempotente, "La primera creación no debe ser idempotente.");
    console.log(`  OC: ${creada.numero_oc} | retroactiva: ${creada.retroactiva}`);

    if (caso === "sol-001") {
      const segunda = await callTool("oc_crear", { caso, payload: orden }, ctx);
      asegurar(segunda.parsed.ok, `La segunda creación falló: ${textoError(segunda)}`);
      const repetida = segunda.parsed.data as {
        numero_oc: string;
        idempotente: boolean;
      };
      asegurar(repetida.idempotente, "La segunda creación debería ser idempotente.");
      asegurar(
        repetida.numero_oc === creada.numero_oc,
        `La segunda creación devolvió ${repetida.numero_oc} en vez de ${creada.numero_oc}.`,
      );
      console.log(`  idempotencia: ${repetida.numero_oc} (misma OC, correcto)`);
    }
  }

  if (caso === "sol-004") {
    asegurar(
      orden.posiciones[0].precio_unitario === 250_000,
      "El payload debe usar el valor unitario de la solicitud (250.000), no el de la cotización.",
    );
    asegurar(
      orden.excepciones.some((excepcion) => excepcion.codigo === "RC5"),
      "Falta la excepción RC5 en el payload.",
    );
    console.log("  decisión: se usa el valor de la solicitud (25.000.000), no el de la cotización.");
  }

  if (caso === "sol-005") {
    asegurar(
      orden.excepciones.some((excepcion) => excepcion.codigo === "RC8"),
      "Falta la excepción RC8 en el payload.",
    );
    console.log("  decisión: la OC queda marcada como retroactiva en el log de control.");
  }

  if (caso === "sol-006") {
    asegurar(
      orden.proveedor.codigo_sap === "100234",
      "El proveedor por nombre debería resolverse a TecnoSuministros (100234).",
    );
    asegurar(
      orden.condiciones_pago === "Z030",
      "La condición de pago derivada debería ser Z030.",
    );
    asegurar(
      orden.posiciones[0].indicador_iva === "C1",
      "El IVA derivado debería ser C1.",
    );
    console.log("  derivados: IVA C1, pago Z030, proveedor 100234 (correcto).");
  }

  console.log("");
}

function asegurar(condicion: unknown, mensaje: string): asserts condicion {
  if (!condicion) throw new Error(mensaje);
}

function textoError(resultado: { parsed: { ok: boolean; error?: string } }): string {
  return resultado.parsed.ok ? "" : resultado.parsed.error ?? "error desconocido";
}

main().catch((error) => {
  console.error("Fallo no controlado en demo.ts:", error);
  process.exitCode = 1;
});
