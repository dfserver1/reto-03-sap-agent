import { createHash } from "node:crypto";
import type { Cotizacion, Factura, ItemCotizacion, Unidad } from "../types/domain";

export function quitarDiacriticos(texto: string): string {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function normalizarNombre(texto: string): string {
  return quitarDiacriticos(texto)
    .toLowerCase()
    .replace(/&/g, " y ")
    .replace(/[.,;:()]/g, " ")
    .replace(/\b(s\.?\s*a\.?\s*s\.?|sas|s\.?\s*a\.?|ltda\.?|limitada)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizarEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function soloDigitos(texto: string): string {
  return texto.replace(/\D/g, "");
}

/**
 * Los maestros traen NIT base de 9 dígitos y las cotizaciones traen
 * "900.555.111-2" (base + dígito de verificación). Comparamos la base.
 * Nota: los DV de los fixtures no cumplen el algoritmo DIAN; por eso no
 * se valida matemáticamente el DV en esta demo (ver SOLUCION.md).
 */
export function nitBase(nit: string): string {
  const digitos = soloDigitos(nit);
  return digitos.length >= 10 ? digitos.slice(0, 9) : digitos;
}

export function parseMoney(input: string | number): number {
  if (typeof input === "number") {
    return Math.round(input * 100) / 100;
  }

  let texto = input.trim().replace(/[^\d.,-]/g, "");
  if (texto === "" || texto === "-") return 0;

  const negativo = texto.startsWith("-");
  texto = texto.replace(/-/g, "");

  const ultimoPunto = texto.lastIndexOf(".");
  const ultimaComa = texto.lastIndexOf(",");
  let normalizado: string;

  if (ultimoPunto >= 0 && ultimaComa >= 0) {
    const separadorDecimal = ultimoPunto > ultimaComa ? "." : ",";
    const separadorMiles = separadorDecimal === "." ? "," : ".";
    normalizado = texto.split(separadorMiles).join("");
    normalizado = normalizado.replace(separadorDecimal, ".");
  } else if (ultimoPunto >= 0 || ultimaComa >= 0) {
    const separador = ultimoPunto >= 0 ? "." : ",";
    const partes = texto.split(separador);
    if (partes.length === 2) {
      const [entero, decimales] = partes;
      if (decimales.length === 3 && entero.length > 0) {
        normalizado = entero + decimales;
      } else if (decimales.length === 0) {
        normalizado = entero;
      } else {
        normalizado = `${entero || "0"}.${decimales}`;
      }
    } else {
      normalizado = partes.join("");
    }
  } else {
    normalizado = texto;
  }

  const numero = Number(normalizado);
  if (!Number.isFinite(numero)) return 0;
  return Math.round((negativo ? -numero : numero) * 100) / 100;
}

export function parseDateOnly(input: string | null | undefined): string | null {
  if (!input) return null;
  const texto = input.trim();

  const iso = texto.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, y, m, d] = iso;
    return fechaValida(Number(y), Number(m), Number(d));
  }

  const dmy = texto.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return fechaValida(Number(y), Number(m), Number(d));
  }

  return null;
}

function fechaValida(anio: number, mes: number, dia: number): string | null {
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  if (
    fecha.getUTCFullYear() !== anio ||
    fecha.getUTCMonth() !== mes - 1 ||
    fecha.getUTCDate() !== dia
  ) {
    return null;
  }
  return `${String(anio).padStart(4, "0")}-${String(mes).padStart(2, "0")}-${String(
    dia,
  ).padStart(2, "0")}`;
}

export function sumarDias(fecha: string, dias: number): string {
  const [y, m, d] = fecha.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + dias);
  return base.toISOString().slice(0, 10);
}

export function diasEntre(desde: string, hasta: string): number {
  const [y1, m1, d1] = desde.split("-").map(Number);
  const [y2, m2, d2] = hasta.split("-").map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86_400_000);
}

export function truncar(texto: string, maximo: number): string {
  const limpio = texto.replace(/\s+/g, " ").trim();
  if (limpio.length <= maximo) return limpio;
  const corte = limpio.slice(0, maximo);
  const ultimoEspacio = corte.lastIndexOf(" ");
  const base = ultimoEspacio > maximo * 0.5 ? corte.slice(0, ultimoEspacio) : corte;
  return base.replace(/[\s,.;:-]+$/, "");
}

export function sha256(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex");
}

export function jsonCanonico(valor: unknown): string {
  return JSON.stringify(ordenar(valor));
}

function ordenar(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(ordenar);
  if (valor && typeof valor === "object") {
    const objeto = valor as Record<string, unknown>;
    const resultado: Record<string, unknown> = {};
    for (const clave of Object.keys(objeto).sort()) {
      resultado[clave] = ordenar(objeto[clave]);
    }
    return resultado;
  }
  return valor;
}

export function inferirUnidad(descripcion: string, cantidad: number): Unidad {
  const texto = quitarDiacriticos(descripcion).toLowerCase();
  if (/bolsa de\s+\d+\s+horas|horas?\s+de|por hora|hora de arquitect/.test(texto)) {
    return "H";
  }
  if (/mensualidad|suscripcion mensual|mes de servicio|servicio mensual/.test(texto)) {
    return "MES";
  }
  if (cantidad === 1 && /mes\b/.test(texto) && /servicio|soporte|licencia/.test(texto)) {
    return "MES";
  }
  return "UN";
}

export function esAprobado(cuerpo: string): boolean {
  const texto = quitarDiacriticos(cuerpo).toLowerCase();
  if (/\b(no aprobado|rechazado|no procede|no autorizado|negado|rechazo)\b/.test(texto)) {
    return false;
  }
  return /\baprobado\b/.test(texto);
}

export function parseCotizacion(texto: string): Cotizacion {
  const lineas = texto.split(/\r?\n/);
  const buscar = (re: RegExp): string | null => {
    for (const linea of lineas) {
      const match = linea.trim().match(re);
      if (match) return match[1]?.trim() ?? null;
    }
    return null;
  };

  const referenciaMatch = lineas[0]?.match(/COTIZACI[OÓ]N\s+(.+)$/i);
  const referencia = referenciaMatch?.[1]?.trim() ?? null;
  const fecha = parseDateOnly(buscar(/^Fecha:\s*(.+)$/i));
  const proveedor = buscar(/^Proveedor:\s*(.+)$/i) ?? "";
  const nit = buscar(/^NIT:\s*(.+)$/i);

  const lineaTotal =
    lineas.find((l) => /TOTAL\s*\(IVA incluido\)/i.test(l)) ??
    lineas.find((l) => /^TOTAL\s*:/i.test(l.trim()));
  const totalTexto = lineaTotal?.split(":").slice(1).join(":") ?? "";
  const total = parseMoney(totalTexto);

  const lineaValidez = lineas.find((l) => /^Validez de la oferta:/i.test(l.trim()));
  const diasValidez = lineaValidez?.match(/(\d+)\s*d[ií]as/i)?.[1];
  const validez_hasta =
    fecha && diasValidez ? sumarDias(fecha, Number(diasValidez)) : null;

  const moneda = /USD/i.test(texto) ? "USD" : "COP";

  const items: ItemCotizacion[] = [];
  const reItem =
    /^\s*\d+\.\s+(.+?)\s*\|\s*Cantidad:\s*([\d.,]+)\s*\|\s*Precio unitario[^:]*:\s*(?:COP|USD)?\s*([\d.,]+)\s*\|\s*Subtotal:\s*(?:COP|USD)?\s*([\d.,]+)/i;
  for (const linea of lineas) {
    const match = linea.match(reItem);
    if (match) {
      items.push({
        descripcion: match[1].trim(),
        cantidad: parseMoney(match[2]),
        precio_unitario: parseMoney(match[3]),
        subtotal: parseMoney(match[4]),
      });
    }
  }

  return {
    proveedor,
    nit,
    total,
    moneda,
    validez_hasta,
    texto,
    referencia,
    fecha,
    items,
  };
}

export function parseFactura(texto: string): Factura {
  const numero = texto.match(/No\.\s*([A-Z0-9-]+)/i)?.[1]?.trim() ?? "";
  const fecha = parseDateOnly(
    texto.match(/Fecha de emisi[oó]n:\s*([0-9/-]+)/i)?.[1] ?? null,
  );
  const total = parseMoney(
    texto.match(/TOTAL:\s*(?:COP|USD)?\s*([\d.,]+)/i)?.[1] ?? "0",
  );
  return {
    numero,
    fecha: fecha ?? "",
    total,
  };
}

export function formatearMoneda(valor: number, moneda = "COP"): string {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: moneda === "USD" ? "USD" : "COP",
    maximumFractionDigits: 2,
  }).format(valor);
}

export function porcentaje(valor: number): string {
  return `${(valor * 100).toFixed(1)}%`;
}
