import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { Aprobacion } from "../types/domain";
import { sha256 } from "./normalize";

export function outDir(directory: string): string {
  const configurado = process.env.OUT_DIR?.trim();
  if (configurado) {
    return path.isAbsolute(configurado)
      ? configurado
      : path.resolve(directory, configurado);
  }
  // En Vercel el filesystem del proyecto es de solo lectura; /tmp sí se
  // puede escribir durante la vida del contenedor de la función.
  if (process.env.VERCEL === "1") return "/tmp/out";
  return path.join(directory, "out");
}

export function rutaOut(directory: string, ...partes: string[]): string {
  return path.join(outDir(directory), ...partes);
}

export function renderAprobacion(aprobacion: Aprobacion): string {
  return [
    `De: ${aprobacion.de}`,
    `Para: ${aprobacion.para ?? ""}`,
    `Fecha: ${aprobacion.fecha}`,
    `Asunto: ${aprobacion.asunto ?? ""}`,
    "---",
    aprobacion.texto.trim(),
  ].join("\n");
}

export function hashAprobacion(aprobacion: Aprobacion): string {
  return sha256(renderAprobacion(aprobacion));
}

export interface EvidenciaGenerada {
  ruta: string;
  sha256: string;
  ruta_pdf?: string;
}

export async function generarEvidencia(
  directory: string,
  caso: string,
  aprobacion: Aprobacion,
): Promise<EvidenciaGenerada> {
  const carpeta = rutaOut(directory, caso);
  await mkdir(carpeta, { recursive: true });

  const contenido = renderAprobacion(aprobacion);
  const hash = sha256(contenido);
  const archivo = `${contenido}\n\n---\nSHA256: ${hash}\n`;
  const rutaTxt = path.join(carpeta, "aprobacion.txt");
  await writeFile(rutaTxt, archivo, "utf8");

  const resultado: EvidenciaGenerada = {
    ruta: rutaRelativa(directory, rutaTxt),
    sha256: hash,
  };

  try {
    const rutaPdf = path.join(carpeta, "aprobacion.pdf");
    const pdf = await PDFDocument.create();
    const pagina = pdf.addPage([612, 792]);
    const fuente = await pdf.embedFont(StandardFonts.Helvetica);
    const titulo = await pdf.embedFont(StandardFonts.HelveticaBold);
    const margen = 54;
    let y = 738;

    pagina.drawText("Evidencia de aprobación", {
      x: margen,
      y,
      size: 15,
      font: titulo,
    });
    y -= 28;

    const lineas = archivo.split(/\r?\n/);
    for (const linea of lineas) {
      for (const parte of envolver(linea, 88)) {
        if (y < 54) break;
        pagina.drawText(parte, {
          x: margen,
          y,
          size: 9.5,
          font: fuente,
        });
        y -= 13;
      }
      if (y < 54) break;
    }

    const bytes = await pdf.save();
    await writeFile(rutaPdf, bytes);
    resultado.ruta_pdf = rutaRelativa(directory, rutaPdf);
  } catch {
    // El PDF es P1 opcional. Si falla, el TXT (P0) sigue siendo válido.
  }

  return resultado;
}

export async function leerEvidencia(
  directory: string,
  caso: string,
): Promise<string | null> {
  try {
    return await readFile(path.join(outDir(directory), caso, "aprobacion.txt"), "utf8");
  } catch {
    return null;
  }
}

function rutaRelativa(directory: string, absoluta: string): string {
  const relativa = path.relative(directory, absoluta);
  return relativa.startsWith("..") ? absoluta : relativa;
}

function envolver(texto: string, maximo: number): string[] {
  const limpio = texto.replace(/\t/g, "    ");
  if (limpio.length <= maximo) return [limpio];
  const resultado: string[] = [];
  let actual = "";
  for (const palabra of limpio.split(" ")) {
    if ((actual + " " + palabra).trim().length > maximo) {
      if (actual.trim()) resultado.push(actual.trim());
      actual = palabra;
    } else {
      actual = `${actual} ${palabra}`;
    }
  }
  if (actual.trim()) resultado.push(actual.trim());
  return resultado;
}
