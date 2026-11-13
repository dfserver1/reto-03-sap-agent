import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { OrdenCompra } from "../types/domain";
import { outDir } from "./evidence";
import { redactarJson, redactar } from "./redact";

export interface ControlRow {
  solicitud_id: string;
  resultado: "CREADA" | "BLOQUEADA" | "PENDIENTE_CONFIRMACION" | "ERROR";
  numero_oc: string;
  retroactiva: boolean;
  bloqueos: string;
  confirmaciones: string;
  ts: string;
}

export interface OrdenRegistrada {
  numero_oc: string;
  fecha: string;
  orden: OrdenCompra;
}

export function rutaControl(directory: string): string {
  return path.join(outDir(directory), "control.csv");
}

export function rutaLog(directory: string): string {
  return path.join(outDir(directory), "log.jsonl");
}

export function rutaOrdenes(directory: string): string {
  return path.join(outDir(directory), "sap", "ordenes.jsonl");
}

export async function asegurarOut(directory: string): Promise<void> {
  await mkdir(outDir(directory), { recursive: true });
  await mkdir(path.join(outDir(directory), "sap"), { recursive: true });
}

export async function limpiarOut(directory: string): Promise<void> {
  await rm(outDir(directory), { recursive: true, force: true });
  await asegurarOut(directory);
}

export async function registrarToolCall(
  directory: string,
  sessionId: string,
  tool: string,
  args: unknown,
  result: unknown,
  durationMs: number,
): Promise<void> {
  await asegurarOut(directory);
  const registro = {
    ts: new Date().toISOString(),
    sessionId,
    tool,
    args,
    result,
    durationMs,
  };
  await appendFile(rutaLog(directory), `${redactarJson(registro)}\n`, "utf8");
}

export async function registrarControl(
  directory: string,
  fila: Omit<ControlRow, "ts"> & { ts?: string },
): Promise<void> {
  await asegurarOut(directory);
  const ruta = rutaControl(directory);
  let existe = true;
  try {
    await readFile(ruta, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") existe = false;
    else throw error;
  }

  if (!existe) {
    await appendFile(
      ruta,
      "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n",
      "utf8",
    );
  }

  const filaCompleta: ControlRow = {
    ...fila,
    ts: fila.ts ?? new Date().toISOString(),
  };

  const valores = [
    filaCompleta.solicitud_id,
    filaCompleta.resultado,
    filaCompleta.numero_oc,
    String(filaCompleta.retroactiva),
    filaCompleta.bloqueos,
    filaCompleta.confirmaciones,
    filaCompleta.ts,
  ].map((valor) => escaparCsv(redactar(valor)));

  await appendFile(ruta, `${valores.join(",")}\n`, "utf8");
}

export async function leerControl(directory: string): Promise<ControlRow[]> {
  try {
    const texto = await readFile(rutaControl(directory), "utf8");
    const lineas = texto.split(/\r?\n/).filter((linea) => linea.trim() !== "");
    if (lineas.length <= 1) return [];
    return lineas.slice(1).map((linea) => {
      const columnas = parsearCsv(linea);
      return {
        solicitud_id: columnas[0] ?? "",
        resultado: (columnas[1] ?? "ERROR") as ControlRow["resultado"],
        numero_oc: columnas[2] ?? "",
        retroactiva: columnas[3] === "true",
        bloqueos: columnas[4] ?? "",
        confirmaciones: columnas[5] ?? "",
        ts: columnas[6] ?? "",
      };
    });
  } catch {
    return [];
  }
}

export async function leerOrdenes(directory: string): Promise<OrdenRegistrada[]> {
  try {
    const texto = await readFile(rutaOrdenes(directory), "utf8");
    return texto
      .split(/\r?\n/)
      .filter((linea) => linea.trim() !== "")
      .map((linea) => JSON.parse(linea) as OrdenRegistrada);
  } catch {
    return [];
  }
}

function escaparCsv(valor: string): string {
  if (/[",\n\r]/.test(valor)) {
    return `"${valor.replace(/"/g, '""')}"`;
  }
  return valor;
}

function parsearCsv(linea: string): string[] {
  const resultado: string[] = [];
  let actual = "";
  let entreComillas = false;
  for (let i = 0; i < linea.length; i += 1) {
    const caracter = linea[i];
    if (caracter === '"') {
      if (entreComillas && linea[i + 1] === '"') {
        actual += '"';
        i += 1;
      } else {
        entreComillas = !entreComillas;
      }
    } else if (caracter === "," && !entreComillas) {
      resultado.push(actual);
      actual = "";
    } else {
      actual += caracter;
    }
  }
  resultado.push(actual);
  return resultado;
}
