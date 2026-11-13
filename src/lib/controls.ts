import type {
  Bloqueo,
  Confirmacion,
  Derivados,
  Maestros,
  Paquete,
  Validacion,
} from "../types/domain";
import {
  buscarAprobador,
  buscarCentro,
  buscarCondicionPago,
  buscarIva,
  buscarProveedor,
} from "./maestros";
import {
  diasEntre,
  formatearMoneda,
  inferirUnidad,
  nitBase,
  normalizarNombre,
  parseDateOnly,
  porcentaje,
} from "./normalize";

export function validarPaquete(paquete: Paquete, maestros: Maestros): Validacion {
  const { solicitud, cotizacion, aprobacion, factura } = paquete;
  const bloqueos: Bloqueo[] = [];
  const confirmaciones: Confirmacion[] = [];
  const derivados: Derivados = {};
  let retroactiva = false;

  const centro = buscarCentro(maestros, solicitud.centro_costo);
  const proveedor = buscarProveedor(
    maestros,
    solicitud.proveedor_nit,
    solicitud.proveedor_nombre,
  );

  const bloquear = (codigo: string, mensaje: string, accion: string): void => {
    bloqueos.push({ codigo, mensaje, accion_sugerida: accion });
  };
  const confirmar = (
    codigo: string,
    mensaje: string,
    valores?: Confirmacion["valores"],
  ): void => {
    confirmaciones.push({ codigo, mensaje, valores });
  };

  // RC1 — Proveedor existente y activo.
  if (!proveedor) {
    bloquear(
      "RC1",
      `El proveedor "${solicitud.proveedor_nombre}"${
        solicitud.proveedor_nit ? ` con NIT ${solicitud.proveedor_nit}` : ""
      } no existe en el maestro de proveedores.`,
      "Solicitar el alta del proveedor en SAP o corregir NIT/nombre en la solicitud.",
    );
  } else if (!proveedor.activo) {
    bloquear(
      "RC1",
      `El proveedor "${proveedor.nombre}" (NIT ${proveedor.nit}) está inactivo en SAP.`,
      "Solicitar reactivación del proveedor o usar un proveedor activo.",
    );
  } else {
    derivados.proveedor = {
      codigo_sap: proveedor.codigo_sap,
      nit: proveedor.nit,
      nombre: proveedor.nombre,
    };
  }

  // RC2 — Aprobación válida del líder autorizado del centro de costo.
  if (!aprobacion) {
    bloquear(
      "RC2",
      "No existe evidencia de aprobación del líder para esta solicitud.",
      "Solicitar al solicitante el correo de aprobación del líder.",
    );
  } else if (!aprobacion.aprobado) {
    bloquear(
      "RC2",
      `El correo de ${aprobacion.de} no contiene una aprobación explícita ("Aprobado").`,
      "Solicitar una aprobación escrita y explícita del líder.",
    );
  } else if (!centro) {
    bloquear(
      "RC2",
      `No se puede validar al aprobador porque el centro de costo "${solicitud.centro_costo}" no existe.`,
      "Corregir el centro de costo en la solicitud.",
    );
  } else {
    const aprobador = buscarAprobador(centro, aprobacion.de);
    if (!aprobador) {
      const autorizados = centro.aprobadores
        .map((item) => `${item.email} (tope ${formatearMoneda(item.tope)})`)
        .join(", ");
      bloquear(
        "RC2",
        `El correo ${aprobacion.de} no es aprobador del centro de costo ${centro.centro_costo} (${centro.nombre}). Autorizados: ${autorizados}.`,
        "Solicitar la aprobación del líder que corresponde al centro de costo o reasignar el centro.",
      );
    } else {
      derivados.aprobador = {
        email: aprobador.email,
        nombre: aprobador.nombre,
        tope: aprobador.tope,
      };
    }
  }

  // RC3 — Tope de aprobación del líder para ese centro.
  if (derivados.aprobador) {
    if (solicitud.valor_total > derivados.aprobador.tope) {
      bloquear(
        "RC3",
        `El valor ${formatearMoneda(
          solicitud.valor_total,
          solicitud.moneda,
        )} excede el tope de ${formatearMoneda(
          derivados.aprobador.tope,
        )} de ${derivados.aprobador.nombre} para ${solicitud.centro_costo}.`,
        "Escalar a un aprobador de mayor nivel o dividir la compra con un proceso autorizado.",
      );
    }
  }

  // RC4 — Subárea perteneciente al centro de costo.
  if (!centro) {
    bloquear(
      "RC4",
      `El centro de costo "${solicitud.centro_costo}" no existe en el maestro.`,
      "Corregir el centro de costo en la solicitud.",
    );
  } else if (
    !centro.subareas.some(
      (subarea) => subarea.trim().toLowerCase() === solicitud.subarea.trim().toLowerCase(),
    )
  ) {
    bloquear(
      "RC4",
      `La subárea "${solicitud.subarea}" no pertenece al centro de costo ${centro.centro_costo}. Subáreas válidas: ${centro.subareas.join(", ")}.`,
      "Corregir la subárea o el centro de costo.",
    );
  }

  // RC5 — Coherencia cotización vs solicitud (tolerancia 2 %).
  if (!cotizacion) {
    confirmar(
      "RC5",
      "No se encontró cotización. Se usaría el valor de la solicitud; confirmar antes de crear la OC.",
      { valor_solicitud: solicitud.valor_total, moneda: solicitud.moneda },
    );
  } else {
    const nitSolicitud = solicitud.proveedor_nit ?? derivados.proveedor?.nit;
    if (cotizacion.nit && nitSolicitud && nitBase(cotizacion.nit) !== nitBase(nitSolicitud)) {
      bloquear(
        "RC5",
        `El NIT de la cotización (${cotizacion.nit}) no coincide con el NIT de la solicitud/proveedor (${nitSolicitud}).`,
        "Solicitar una cotización del proveedor correcto o corregir la solicitud.",
      );
    } else if (
      cotizacion.nit === null &&
      cotizacion.proveedor &&
      normalizarNombre(cotizacion.proveedor) !== normalizarNombre(solicitud.proveedor_nombre)
    ) {
      confirmar(
        "RC5",
        `El proveedor de la cotización ("${cotizacion.proveedor}") no coincide con el de la solicitud ("${solicitud.proveedor_nombre}").`,
        {
          proveedor_cotizacion: cotizacion.proveedor,
          proveedor_solicitud: solicitud.proveedor_nombre,
        },
      );
    }

    if (cotizacion.moneda !== solicitud.moneda) {
      bloquear(
        "RC5",
        `La moneda de la cotización (${cotizacion.moneda}) no coincide con la de la solicitud (${solicitud.moneda}).`,
        "Solicitar la cotización en la moneda de la solicitud o registrar la conversión autorizada.",
      );
    } else if (cotizacion.total <= 0) {
      confirmar(
        "RC5",
        "No se pudo leer el total de la cotización. Confirmar el valor antes de crear la OC.",
        { valor_solicitud: solicitud.valor_total, total_cotizacion: cotizacion.total },
      );
    } else if (solicitud.valor_total > 0) {
      const diferencia = Math.abs(cotizacion.total - solicitud.valor_total) / solicitud.valor_total;
      if (diferencia > 0.02) {
        confirmar(
          "RC5",
          `La cotización (${formatearMoneda(cotizacion.total, solicitud.moneda)}) difiere de la solicitud (${formatearMoneda(
            solicitud.valor_total,
            solicitud.moneda,
          )}) en ${porcentaje(diferencia)}, por encima de la tolerancia del 2 %.`,
          {
            valor_solicitud: solicitud.valor_total,
            total_cotizacion: cotizacion.total,
            diferencia_pct: Number((diferencia * 100).toFixed(2)),
          },
        );
      }
    }
  }

  // RC6 — Indicador de IVA informado o derivado del proveedor.
  if (solicitud.indicador_iva) {
    const iva = buscarIva(maestros, solicitud.indicador_iva);
    if (!iva) {
      bloquear(
        "RC6",
        `El indicador de IVA "${solicitud.indicador_iva}" no existe en el maestro.`,
        "Corregir el indicador de IVA (C0, C1 o C2).",
      );
    } else {
      derivados.indicador_iva = iva.codigo;
    }
  } else if (proveedor) {
    const ivaDefault = buscarIva(maestros, proveedor.indicador_iva_default);
    if (!ivaDefault) {
      bloquear(
        "RC6",
        `El proveedor no tiene un indicador de IVA default válido y la solicitud no lo informa.`,
        "Solicitar el indicador de IVA al proveedor o al área contable.",
      );
    } else {
      derivados.indicador_iva = ivaDefault.codigo;
      confirmar(
        "RC6",
        `La solicitud no informa indicador de IVA. Se propone ${ivaDefault.codigo} (${ivaDefault.descripcion}, tasa ${porcentaje(
          ivaDefault.tasa,
        )}) según el default del proveedor. Confirmar antes de crear la OC.`,
        {
          codigo: ivaDefault.codigo,
          descripcion: ivaDefault.descripcion,
          tasa: ivaDefault.tasa,
        },
      );
    }
  } else {
    confirmar(
      "RC6",
      "La solicitud no informa indicador de IVA y no se pudo derivar del proveedor. Confirmar el código antes de crear la OC.",
      { codigo: solicitud.indicador_iva ?? null },
    );
  }

  // RC7 — Condiciones de pago informadas o derivadas del proveedor.
  if (solicitud.condiciones_pago) {
    const condicion = buscarCondicionPago(maestros, solicitud.condiciones_pago);
    if (!condicion) {
      bloquear(
        "RC7",
        `La condición de pago "${solicitud.condiciones_pago}" no existe en el maestro.`,
        "Corregir la condición de pago (Z000, Z015, Z030 o Z060).",
      );
    } else {
      derivados.condiciones_pago = condicion.codigo;
    }
  } else if (proveedor) {
    const condicionDefault = buscarCondicionPago(
      maestros,
      proveedor.condiciones_pago_default,
    );
    if (!condicionDefault) {
      bloquear(
        "RC7",
        "El proveedor no tiene una condición de pago default válida y la solicitud no la informa.",
        "Solicitar la condición de pago al proveedor o a tesorería.",
      );
    } else {
      derivados.condiciones_pago = condicionDefault.codigo;
    }
  } else {
    bloquear(
      "RC7",
      "La solicitud no informa condición de pago y no se pudo derivar del proveedor.",
      "Solicitar la condición de pago al proveedor.",
    );
  }

  // RC8 — Compra retroactiva: factura anterior a la solicitud.
  if (factura) {
    const fechaFactura = parseDateOnly(factura.fecha);
    if (!fechaFactura) {
      confirmar(
        "RC8",
        "Existe una factura pero no se pudo leer su fecha de emisión. Confirmar antes de crear la OC.",
        { factura: factura.numero, fecha_factura: factura.fecha },
      );
    } else if (fechaFactura < solicitud.fecha_solicitud) {
      retroactiva = true;
      confirmar(
        "RC8",
        `Compra retroactiva: la factura ${factura.numero} fue emitida el ${fechaFactura}, ${diasEntre(
          fechaFactura,
          solicitud.fecha_solicitud,
        )} días antes de la solicitud (${solicitud.fecha_solicitud}). La OC quedaría marcada como retroactiva.`,
        {
          factura: factura.numero,
          fecha_factura: fechaFactura,
          fecha_solicitud: solicitud.fecha_solicitud,
          dias_antes: diasEntre(fechaFactura, solicitud.fecha_solicitud),
        },
      );
    }
  }

  // RC9 — La aprobación no puede ser anterior a la solicitud.
  if (aprobacion) {
    const fechaAprobacion = parseDateOnly(aprobacion.fecha);
    if (fechaAprobacion && fechaAprobacion < solicitud.fecha_solicitud) {
      confirmar(
        "RC9",
        `La aprobación (${fechaAprobacion}) es anterior a la solicitud (${solicitud.fecha_solicitud}). Confirmar la validez de la evidencia.`,
        {
          fecha_aprobacion: fechaAprobacion,
          fecha_solicitud: solicitud.fecha_solicitud,
        },
      );
    }
  }

  // RC10 — Coherencia cantidad × valor unitario vs valor total.
  const esperado = solicitud.cantidad * solicitud.valor_unitario;
  if (Math.abs(esperado - solicitud.valor_total) > 1) {
    bloquear(
      "RC10",
      `Cantidad × valor unitario = ${formatearMoneda(
        esperado,
        solicitud.moneda,
      )}, pero el valor total de la solicitud es ${formatearMoneda(
        solicitud.valor_total,
        solicitud.moneda,
      )}.`,
      "Corregir cantidad, valor unitario o valor total en la solicitud.",
    );
  }

  derivados.unidad = inferirUnidad(solicitud.descripcion, solicitud.cantidad);

  return {
    apta: bloqueos.length === 0,
    bloqueos,
    confirmaciones,
    derivados,
    retroactiva,
  };
}
