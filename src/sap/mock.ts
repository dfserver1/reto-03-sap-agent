import { appendFile } from "node:fs/promises";
import type { OrdenCompra } from "../types/domain";
import { asegurarOut, leerOrdenes, rutaOrdenes } from "../lib/audit";
import { cargarMaestros } from "../lib/maestros";
import { nitBase } from "../lib/normalize";
import type { SapAdapter } from "./adapter";

const NUMERO_INICIAL = 4_500_000_000;

// Cola global: serializa la lectura y escritura del archivo de órdenes para
// evitar condiciones de carrera en la creación concurrente de OC.
let cola: Promise<unknown> = Promise.resolve();

function enCola<T>(tarea: () => Promise<T>): Promise<T> {
  const resultado = cola.then(tarea, tarea);
  cola = resultado.then(
    () => undefined,
    () => undefined,
  );
  return resultado;
}

export class SapMock implements SapAdapter {
  constructor(private readonly directory: string) {}

  async consultarProveedor(
    nit: string,
  ): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const maestros = await cargarMaestros(this.directory);
    const proveedor = maestros.proveedores.find(
      (item) => nitBase(item.nit) === nitBase(nit),
    );
    if (!proveedor) return null;
    return { codigo_sap: proveedor.codigo_sap, activo: proveedor.activo };
  }

  async buscarOrdenPorReferencia(
    solicitud_id: string,
  ): Promise<{ numero_oc: string } | null> {
    const ordenes = await leerOrdenes(this.directory);
    const encontrada = ordenes.find(
      (item) => item.orden.referencia.solicitud_id === solicitud_id,
    );
    return encontrada ? { numero_oc: encontrada.numero_oc } : null;
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    await asegurarOut(this.directory);
    return enCola(async () => {
      const ordenes = await leerOrdenes(this.directory);
      const existente = ordenes.find(
        (item) => item.orden.referencia.solicitud_id === orden.referencia.solicitud_id,
      );
      if (existente) {
        return { numero_oc: existente.numero_oc, fecha: existente.fecha };
      }
      const numero_oc = String(NUMERO_INICIAL + ordenes.length + 1);
      const fecha = new Date().toISOString();
      await appendFile(
        rutaOrdenes(this.directory),
        `${JSON.stringify({ numero_oc, fecha, orden })}\n`,
        "utf8",
      );
      return { numero_oc, fecha };
    });
  }
}
