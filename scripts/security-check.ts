import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const EXTENSIONES = new Set([".ts", ".tsx", ".js", ".jsx"]);
const CARPETA_IGNORADA = new Set(["node_modules", "dist", "public", "out", "coverage", ".git", ".vercel"]);

interface PatronSecreto {
  nombre: string;
  patron: RegExp;
}

const PATRONES_SECRETO: PatronSecreto[] = [
  { nombre: "Google API key", patron: /AIza[0-9A-Za-z_-]{10,}/ },
  { nombre: "OpenAI key", patron: /sk-[0-9A-Za-z_-]{10,}/ },
  { nombre: "GitHub token", patron: /gh[pousr]_[0-9A-Za-z_-]{10,}/ },
  { nombre: "Private key", patron: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

function todosLosArchivos(directory: string): string[] {
  const entradas = readdirSync(directory, { withFileTypes: true });
  const archivos: string[] = [];
  for (const entrada of entradas) {
    if (CARPETA_IGNORADA.has(entrada.name)) continue;
    const ruta = path.join(directory, entrada.name);
    if (entrada.isDirectory()) {
      archivos.push(...todosLosArchivos(ruta));
      continue;
    }
    const extension = path.extname(entrada.name).toLowerCase();
    if (EXTENSIONES.has(extension)) archivos.push(ruta);
  }
  return archivos;
}

async function main(): Promise<void> {
  const problemas: string[] = [];
  const archivos = todosLosArchivos(ROOT).filter(
    (ruta) => !ruta.split(path.sep).some((parte) => CARPETA_IGNORADA.has(parte)),
  );

  for (const archivo of archivos) {
    const relativo = path.relative(ROOT, archivo).split(path.sep).join("/");
    const texto = readFileSync(archivo, "utf8");
    if (/\.map$/.test(archivo)) {
      problemas.push(`${relativo}: contiene source maps.`);
    }
    if (/@ts-[a-z-]+|:\s*any\b/.test(texto)) {
      problemas.push(`${relativo}: contiene tipos any o directivas de TypeScript.`);
    }
    if (
      /\bprocess\.env\.(GEMINI_API_KEY|GOOGLE_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*=\s*["'][^"']+["']/i.test(
        texto,
      )
    ) {
      problemas.push(`${relativo}: expone una clave por defecto en el codigo.`);
    }
    for (const patron of PATRONES_SECRETO) {
      if (patron.patron.test(texto)) {
        problemas.push(`${relativo}: detectado posible secreto (${patron.nombre}).`);
      }
    }
  }

  const secretosEnVariables = Object.keys(process.env).filter((clave) =>
    /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(clave) && Boolean(process.env[clave]),
  );
  if (secretosEnVariables.length > 0) {
    problemas.push(`Variables de entorno con secreto detectadas: ${secretosEnVariables.join(", ")}.`);
  }

  if (problemas.length > 0) {
    console.error("Problemas de seguridad detectados:");
    for (const problema of problemas) console.error(` - ${problema}`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK: revision de seguridad sin hallazgos en ${archivos.length} archivos.`);
}

void main();
