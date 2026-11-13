import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  CentroCosto,
  CondicionPago,
  IndicadorIva,
  Maestros,
  Proveedor,
} from "../types/domain";
import { normalizarNombre, nitBase, soloDigitos } from "./normalize";

const cache = new Map<string, Maestros>();

async function leerJson<T>(ruta: string): Promise<T> {
  const texto = await readFile(ruta, "utf8");
  try {
    return JSON.parse(texto) as T;
  } catch (error) {
    throw new Error(`JSON inválido en ${ruta}: ${(error as Error).message}`);
  }
}

export async function cargarMaestros(directory: string): Promise<Maestros> {
  const raiz = path.join(directory, "fixtures", "reto-03", "maestros");
  const existente = cache.get(raiz);
  if (existente) return existente;

  const [proveedores, centrosCosto, indicadoresIva, condicionesPago] =
    await Promise.all([
      leerJson<Proveedor[]>(path.join(raiz, "proveedores.json")),
      leerJson<CentroCosto[]>(path.join(raiz, "centros-costo.json")),
      leerJson<IndicadorIva[]>(path.join(raiz, "indicadores-iva.json")),
      leerJson<CondicionPago[]>(path.join(raiz, "condiciones-pago.json")),
    ]);

  if (!Array.isArray(proveedores) || !Array.isArray(centrosCosto)) {
    throw new Error("Maestros inválidos: se esperaban arreglos de proveedores y centros de costo");
  }

  const maestros: Maestros = {
    proveedores,
    centrosCosto,
    indicadoresIva,
    condicionesPago,
  };
  cache.set(raiz, maestros);
  return maestros;
}

export function buscarProveedor(
  maestros: Maestros,
  nit: string | undefined,
  nombre: string,
): Proveedor | null {
  if (nit && soloDigitos(nit).length > 0) {
    const base = nitBase(nit);
    return (
      maestros.proveedores.find((proveedor) => nitBase(proveedor.nit) === base) ?? null
    );
  }

  const nombreNormalizado = normalizarNombre(nombre);
  return (
    maestros.proveedores.find(
      (proveedor) => normalizarNombre(proveedor.nombre) === nombreNormalizado,
    ) ?? null
  );
}

export function buscarCentro(
  maestros: Maestros,
  centroCosto: string,
): CentroCosto | null {
  return (
    maestros.centrosCosto.find(
      (centro) => centro.centro_costo.toLowerCase() === centroCosto.trim().toLowerCase(),
    ) ?? null
  );
}

export function buscarAprobador(
  centro: CentroCosto | null,
  email: string,
): { email: string; nombre: string; tope: number } | null {
  if (!centro) return null;
  const correo = email.trim().toLowerCase();
  return centro.aprobadores.find((aprobador) => aprobador.email.toLowerCase() === correo) ?? null;
}

export function buscarIva(
  maestros: Maestros,
  codigo: string | undefined,
): IndicadorIva | null {
  if (!codigo) return null;
  return (
    maestros.indicadoresIva.find(
      (indicador) => indicador.codigo.toLowerCase() === codigo.trim().toLowerCase(),
    ) ?? null
  );
}

export function buscarCondicionPago(
  maestros: Maestros,
  codigo: string | undefined,
): CondicionPago | null {
  if (!codigo) return null;
  return (
    maestros.condicionesPago.find(
      (condicion) => condicion.codigo.toLowerCase() === codigo.trim().toLowerCase(),
    ) ?? null
  );
}

export function limpiarCacheMaestros(): void {
  cache.clear();
}
