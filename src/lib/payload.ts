import type {
  Maestros,
  OrdenCompra,
  Paquete,
  Validacion,
} from "../types/domain";
import { hashAprobacion } from "./evidence";
import { formatearMoneda, inferirUnidad, truncar } from "./normalize";

export interface ResultadoPayload {
  orden: OrdenCompra;
  trazabilidad: Record<string, string>;
}

export function construirOrden(
  paquete: Paquete,
  validacion: Validacion,
  _maestros: Maestros,
): ResultadoPayload {
  const { solicitud, correo, cotizacion, aprobacion } = paquete;

  if (!aprobacion) {
    throw new Error("No hay evidencia de aprobación para construir el payload.");
  }
  if (!validacion.apta) {
    throw new Error(
      `La solicitud no es apta para OC. Bloqueos: ${validacion.bloqueos
        .map((bloqueo) => bloqueo.codigo)
        .join(", ")}.`,
    );
  }

  const proveedor = validacion.derivados.proveedor;
  if (!proveedor) {
    throw new Error("No se pudo derivar el proveedor del maestro.");
  }

  const aprobador = validacion.derivados.aprobador;
  if (!aprobador) {
    throw new Error("No se pudo derivar el aprobador autorizado.");
  }

  const condicionesPago =
    validacion.derivados.condiciones_pago ?? solicitud.condiciones_pago;
  if (!condicionesPago) {
    throw new Error("No se pudo determinar la condición de pago.");
  }

  const indicadorIva = validacion.derivados.indicador_iva ?? solicitud.indicador_iva;
  if (!indicadorIva) {
    throw new Error("No se pudo determinar el indicador de IVA.");
  }

  const unidad = validacion.derivados.unidad ?? inferirUnidad(solicitud.descripcion, solicitud.cantidad);
  const descripcion = truncar(solicitud.descripcion, 40);
  const evidenciaSha = hashAprobacion(aprobacion);

  const orden: OrdenCompra = {
    referencia: {
      solicitud_id: solicitud.solicitud_id,
      correo_id: correo.id,
      cotizacion_ref: cotizacion?.referencia ?? null,
    },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor,
    moneda: solicitud.moneda,
    condiciones_pago: condicionesPago,
    aprobador: {
      email: aprobador.email,
      fecha_aprobacion: aprobacion.fecha,
      evidencia_sha256: evidenciaSha,
    },
    posiciones: [
      {
        numero: 10,
        descripcion,
        cantidad: solicitud.cantidad,
        unidad,
        precio_unitario: solicitud.valor_unitario,
        centro_costo: solicitud.centro_costo,
        subarea: solicitud.subarea,
        indicador_iva: indicadorIva,
      },
    ],
    excepciones: validacion.confirmaciones.map((confirmacion) => ({
      codigo: confirmacion.codigo,
      detalle: confirmacion.mensaje,
      confirmado_por: null,
    })),
  };

  const trazabilidad: Record<string, string> = {
    "referencia.solicitud_id": "solicitud.solicitud_id",
    "referencia.correo_id": "correo.id",
    "referencia.cotizacion_ref": "cotizacion.referencia",
    "sociedad": "constante del adaptador SAP (1000)",
    "organizacion_compras": "constante del adaptador SAP (1000)",
    "proveedor.codigo_sap": "maestro.proveedores",
    "proveedor.nit": "maestro.proveedores",
    "proveedor.nombre": "maestro.proveedores",
    "moneda": "solicitud.moneda",
    "condiciones_pago": "solicitud.condiciones_pago | maestro.proveedores.condiciones_pago_default",
    "aprobador.email": "maestro.centros-costo.aprobadores",
    "aprobador.fecha_aprobacion": "aprobacion.fecha",
    "aprobador.evidencia_sha256": "aprobacion.texto (sha256)",
    "posiciones[0].descripcion": "solicitud.descripcion (truncada a 40)",
    "posiciones[0].cantidad": "solicitud.cantidad",
    "posiciones[0].unidad": "derivado de solicitud.descripcion",
    "posiciones[0].precio_unitario": "solicitud.valor_unitario",
    "posiciones[0].centro_costo": "solicitud.centro_costo",
    "posiciones[0].subarea": "solicitud.subarea",
    "posiciones[0].indicador_iva": "solicitud.indicador_iva | maestro.proveedores.indicador_iva_default",
    "excepciones": "confirmaciones de oc_validar",
  };

  return { orden, trazabilidad };
}

export function resumenPayload(orden: OrdenCompra): string {
  const posicion = orden.posiciones[0];
  return [
    `Proveedor: ${orden.proveedor.nombre} (${orden.proveedor.codigo_sap})`,
    `Referencia: ${orden.referencia.solicitud_id}`,
    `Moneda: ${orden.moneda}`,
    `Condición de pago: ${orden.condiciones_pago}`,
    `Posición 10: ${posicion.descripcion}`,
    `Cantidad: ${posicion.cantidad} ${posicion.unidad} × ${formatearMoneda(
      posicion.precio_unitario,
      orden.moneda,
    )} = ${formatearMoneda(posicion.cantidad * posicion.precio_unitario, orden.moneda)}`,
    `Centro de costo: ${posicion.centro_costo} / ${posicion.subarea}`,
    `IVA: ${posicion.indicador_iva}`,
  ].join("\n");
}
