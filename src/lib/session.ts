import type { LlmMessage } from "../llm/adapter";
import type { OrdenCompra, Validacion } from "../types/domain";

export interface HerramientaEjecutada {
  id: string;
  name: string;
  args: unknown;
  result: unknown;
  ok: boolean;
  durationMs: number;
}

export interface EvidenciaPendiente {
  ruta: string;
  sha256: string;
  ruta_pdf?: string;
}

export interface PendienteConfirmacion {
  caso: string;
  validacion: Validacion;
  orden: OrdenCompra;
  evidencia?: EvidenciaPendiente;
  resumen: string;
}

export interface ListoParaCrear {
  caso: string;
  orden: OrdenCompra;
  evidencia?: EvidenciaPendiente;
}

export interface Sesion {
  id: string;
  creada: string;
  actualizada: string;
  messages: LlmMessage[];
  toolCalls: HerramientaEjecutada[];
  pending?: PendienteConfirmacion;
  listoParaCrear?: ListoParaCrear;
  needsConfirmation: boolean;
  /** Tokens consumidos por el proveedor LLM en esta sesión. */
  tokensUsados: number;
}

const sesiones = new Map<string, Sesion>();
const MAX_SESIONES = 50;
const PATRON_SESION = /^[A-Za-z0-9_-]{3,64}$/;

export function esIdSesionValido(id: string): boolean {
  return PATRON_SESION.test(id);
}

export function obtenerSesion(id: string): Sesion {
  const existente = sesiones.get(id);
  if (existente) return existente;

  if (sesiones.size >= MAX_SESIONES) {
    const masAntigua = [...sesiones.values()].sort((a, b) =>
      a.actualizada.localeCompare(b.actualizada),
    )[0];
    if (masAntigua) sesiones.delete(masAntigua.id);
  }

  const ahora = new Date().toISOString();
  const nueva: Sesion = {
    id,
    creada: ahora,
    actualizada: ahora,
    messages: [],
    toolCalls: [],
    needsConfirmation: false,
    tokensUsados: 0,
  };
  sesiones.set(id, nueva);
  return nueva;
}

export function reiniciarSesion(id: string): Sesion {
  sesiones.delete(id);
  return obtenerSesion(id);
}

export function guardarSesion(sesion: Sesion): void {
  sesion.actualizada = new Date().toISOString();
  sesiones.set(sesion.id, sesion);
}
