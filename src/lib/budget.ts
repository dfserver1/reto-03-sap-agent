export class PresupuestoAgotadoError extends Error {
  constructor(
    readonly limite: number,
    readonly usados: number,
  ) {
    super("Presupuesto diario de tokens agotado.");
    this.name = "PresupuestoAgotadoError";
  }
}

export interface EstadoPresupuesto {
  limiteDiario: number;
  usados: number;
  fecha: string;
}

let fecha = new Date().toISOString().slice(0, 10);
let usados = 0;

function reiniciarSiNuevaFecha(): void {
  const hoy = new Date().toISOString().slice(0, 10);
  if (hoy !== fecha) {
    fecha = hoy;
    usados = 0;
  }
}

export function limiteTokensDiarios(): number {
  const valor = Number(process.env.MAX_TOKENS_DIA);
  return Number.isFinite(valor) && valor > 0 ? valor : 200_000;
}

export function verificarPresupuesto(): void {
  reiniciarSiNuevaFecha();
  const limite = limiteTokensDiarios();
  if (usados >= limite) {
    throw new PresupuestoAgotadoError(limite, usados);
  }
}

export function registrarTokens(tokens: number): void {
  reiniciarSiNuevaFecha();
  usados += Math.max(0, Math.round(tokens));
}

export function estadoPresupuesto(): EstadoPresupuesto {
  reiniciarSiNuevaFecha();
  return { limiteDiario: limiteTokensDiarios(), usados, fecha };
}
