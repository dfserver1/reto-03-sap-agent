import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type {
  Aprobacion,
  Correo,
  Cotizacion,
  Factura,
  Moneda,
  Paquete,
  Solicitud,
} from "../types/domain";
import {
  esAprobado,
  parseCotizacion,
  parseDateOnly,
  parseFactura,
  parseMoney,
} from "./normalize";

export const CASOS = [
  "sol-001",
  "sol-002",
  "sol-003",
  "sol-004",
  "sol-005",
  "sol-006",
] as const;

export type CasoId = (typeof CASOS)[number];

export function esCasoId(valor: string): valor is CasoId {
  return (CASOS as readonly string[]).includes(valor);
}

export function raizSolicitudes(directory: string): string {
  return path.join(directory, "fixtures", "reto-03", "solicitudes");
}

export function rutaCaso(directory: string, caso: string): string {
  if (!/^sol-\d{3}$/.test(caso)) {
    throw new Error(`Caso inválido: "${caso}". Formato esperado: sol-001.`);
  }
  const raiz = path.resolve(raizSolicitudes(directory));
  const ruta = path.resolve(raiz, caso);
  if (!ruta.startsWith(raiz + path.sep)) {
    throw new Error(`Caso fuera de la carpeta de fixtures: "${caso}".`);
  }
  return ruta;
}

async function leerTexto(ruta: string): Promise<string> {
  return readFile(ruta, "utf8");
}

async function leerTextoOpcional(ruta: string): Promise<string | null> {
  try {
    return await leerTexto(ruta);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function leerJson<T>(ruta: string): Promise<T> {
  let texto: string;
  try {
    texto = await leerTexto(ruta);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Falta el archivo obligatorio "${path.basename(ruta)}" en el paquete.`,
      );
    }
    throw error;
  }
  try {
    return JSON.parse(texto) as T;
  } catch (error) {
    throw new Error(`JSON inválido en ${path.basename(ruta)}: ${(error as Error).message}`);
  }
}

async function leerJsonOpcional<T>(ruta: string): Promise<T | null> {
  let texto: string;
  try {
    texto = await leerTexto(ruta);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(texto) as T;
  } catch (error) {
    // Si existe pero está malformado, el error debe ser visible.
    throw new Error(`JSON inválido en ${path.basename(ruta)}: ${(error as Error).message}`);
  }
}

function numero(valor: unknown, campo: string): number {
  const numero = typeof valor === "number" ? valor : parseMoney(String(valor ?? ""));
  if (!Number.isFinite(numero)) {
    throw new Error(`El campo "${campo}" no es numérico.`);
  }
  return numero;
}

function textoRequerido(valor: unknown, campo: string): string {
  if (typeof valor !== "string" || valor.trim() === "") {
    throw new Error(`Falta el campo obligatorio "${campo}".`);
  }
  return valor.trim();
}

function normalizarSolicitud(raw: Record<string, unknown>): Solicitud {
  const monedaRaw = String(raw.moneda ?? "COP").toUpperCase();
  if (monedaRaw !== "COP" && monedaRaw !== "USD") {
    throw new Error(`Moneda no soportada: "${monedaRaw}". Se espera COP o USD.`);
  }
  const fecha = parseDateOnly(typeof raw.fecha_solicitud === "string" ? raw.fecha_solicitud : null);
  if (!fecha) {
    throw new Error(`Fecha de solicitud inválida: "${String(raw.fecha_solicitud ?? "")}".`);
  }

  return {
    solicitud_id: textoRequerido(raw.solicitud_id, "solicitud_id"),
    solicitante: textoRequerido(raw.solicitante, "solicitante"),
    proveedor_nombre: textoRequerido(raw.proveedor_nombre, "proveedor_nombre"),
    proveedor_nit:
      typeof raw.proveedor_nit === "string" && raw.proveedor_nit.trim() !== ""
        ? raw.proveedor_nit.trim()
        : undefined,
    descripcion: textoRequerido(raw.descripcion, "descripcion"),
    centro_costo: textoRequerido(raw.centro_costo, "centro_costo"),
    subarea: textoRequerido(raw.subarea, "subarea"),
    cantidad: numero(raw.cantidad, "cantidad"),
    valor_unitario: numero(raw.valor_unitario, "valor_unitario"),
    valor_total: numero(raw.valor_total, "valor_total"),
    moneda: monedaRaw as Moneda,
    indicador_iva:
      typeof raw.indicador_iva === "string" && raw.indicador_iva.trim() !== ""
        ? raw.indicador_iva.trim()
        : undefined,
    condiciones_pago:
      typeof raw.condiciones_pago === "string" && raw.condiciones_pago.trim() !== ""
        ? raw.condiciones_pago.trim()
        : undefined,
    fecha_solicitud: fecha,
  };
}

function normalizarCorreo(raw: Record<string, unknown>): Correo {
  return {
    id: textoRequerido(raw.id, "correo.id"),
    de: textoRequerido(raw.de, "correo.de"),
    para: typeof raw.para === "string" ? raw.para : undefined,
    asunto: textoRequerido(raw.asunto, "correo.asunto"),
    fecha: textoRequerido(raw.fecha, "correo.fecha"),
    cuerpo: typeof raw.cuerpo === "string" ? raw.cuerpo : "",
    adjuntos: Array.isArray(raw.adjuntos)
      ? raw.adjuntos.filter((item): item is string => typeof item === "string")
      : undefined,
  };
}

function normalizarAprobacion(raw: Record<string, unknown>): Aprobacion {
  const cuerpo = typeof raw.cuerpo === "string" ? raw.cuerpo : "";
  return {
    de: textoRequerido(raw.de, "aprobacion.de"),
    para: typeof raw.para === "string" ? raw.para : undefined,
    asunto: typeof raw.asunto === "string" ? raw.asunto : undefined,
    fecha: textoRequerido(raw.fecha, "aprobacion.fecha"),
    aprobado: esAprobado(cuerpo),
    texto: cuerpo,
  };
}

export async function leerPaquete(caso: string, directory: string): Promise<Paquete> {
  const carpeta = rutaCaso(directory, caso);

  const [correoRaw, solicitudRaw, cotizacionTexto, aprobacionRaw, facturaTexto] =
    await Promise.all([
      leerJson<Record<string, unknown>>(path.join(carpeta, "correo.json")),
      leerJson<Record<string, unknown>>(path.join(carpeta, "solicitud.json")),
      leerTextoOpcional(path.join(carpeta, "cotizacion.txt")),
      leerJsonOpcional<Record<string, unknown>>(path.join(carpeta, "aprobacion.json")),
      leerTextoOpcional(path.join(carpeta, "factura.txt")),
    ]);

  const correo = normalizarCorreo(correoRaw);
  const solicitud = normalizarSolicitud(solicitudRaw);

  const cotizacion: Cotizacion | null =
    cotizacionTexto && cotizacionTexto.trim() !== ""
      ? parseCotizacion(cotizacionTexto)
      : null;

  const aprobacion: Aprobacion | null = aprobacionRaw
    ? normalizarAprobacion(aprobacionRaw)
    : null;

  const factura: Factura | null =
    facturaTexto && facturaTexto.trim() !== "" ? parseFactura(facturaTexto) : null;

  const faltantes: string[] = [];
  if (!cotizacion) faltantes.push("cotizacion.txt");
  if (!aprobacion) faltantes.push("aprobacion.json");
  // factura.txt es opcional por diseño: solo existe en casos retroactivos.

  return { correo, solicitud, cotizacion, aprobacion, factura, faltantes };
}

export interface ResumenCaso {
  caso: string;
  solicitud_id: string;
  solicitante: string;
  proveedor_nombre: string;
  descripcion: string;
  centro_costo: string;
  subarea: string;
  valor_total: number;
  moneda: string;
  fecha_solicitud: string;
  error?: string;
}

export async function listarResumenes(directory: string): Promise<ResumenCaso[]> {
  const raiz = raizSolicitudes(directory);
  const entradas = await readdir(raiz, { withFileTypes: true });
  const casos = entradas
    .filter((entrada) => entrada.isDirectory() && /^sol-\d{3}$/.test(entrada.name))
    .map((entrada) => entrada.name)
    .sort();

  const resumenes: ResumenCaso[] = [];
  for (const caso of casos) {
    try {
      const raw = await leerJson<Record<string, unknown>>(
        path.join(raiz, caso, "solicitud.json"),
      );
      const solicitud = normalizarSolicitud(raw);
      resumenes.push({
        caso,
        solicitud_id: solicitud.solicitud_id,
        solicitante: solicitud.solicitante,
        proveedor_nombre: solicitud.proveedor_nombre,
        descripcion: solicitud.descripcion,
        centro_costo: solicitud.centro_costo,
        subarea: solicitud.subarea,
        valor_total: solicitud.valor_total,
        moneda: solicitud.moneda,
        fecha_solicitud: solicitud.fecha_solicitud,
      });
    } catch (error) {
      resumenes.push({
        caso,
        solicitud_id: caso,
        solicitante: "",
        proveedor_nombre: "",
        descripcion: "",
        centro_costo: "",
        subarea: "",
        valor_total: 0,
        moneda: "COP",
        fecha_solicitud: "",
        error: (error as Error).message,
      });
    }
  }
  return resumenes;
}
