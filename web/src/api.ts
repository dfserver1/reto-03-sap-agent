export interface Health {
  ok: boolean;
  provider: string;
  model: string;
  determinista: boolean;
  presupuesto?: {
    limite: number;
    usados: number;
    resetEn: string;
  };
}

export interface CaseSummary {
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

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
  result: unknown;
  ok: boolean;
  durationMs: number;
}

export interface Confirmacion {
  codigo: string;
  mensaje: string;
  valores?: Record<string, unknown>;
}

export interface OrdenCompra {
  referencia: {
    solicitud_id: string;
    correo_id: string;
    cotizacion_ref: string | null;
  };
  sociedad: string;
  organizacion_compras: string;
  proveedor: { codigo_sap: string; nit: string; nombre: string };
  moneda: string;
  condiciones_pago: string;
  aprobador: {
    email: string;
    fecha_aprobacion: string;
    evidencia_sha256: string;
  };
  posiciones: Array<{
    numero: number;
    descripcion: string;
    cantidad: number;
    unidad: string;
    precio_unitario: number;
    centro_costo: string;
    subarea: string;
    indicador_iva: string;
  }>;
  excepciones: Array<{
    codigo: string;
    detalle: string;
    confirmado_por: string | null;
  }>;
}

export interface Evidencia {
  ruta: string;
  sha256: string;
  ruta_pdf?: string;
}

export interface Pending {
  caso: string;
  resumen: string;
  confirmaciones: Confirmacion[];
  derivados: Record<string, unknown>;
  retroactiva: boolean;
  orden: OrdenCompra;
  evidencia: Evidencia | null;
}

export interface ChatResponse {
  ok: boolean;
  sessionId: string;
  reply: string;
  toolCalls: ToolCall[];
  needsConfirmation: boolean;
  pending: Pending | null;
}

export interface SessionResponse {
  ok: boolean;
  sessionId: string;
  messages: Array<{
    role: "user" | "assistant" | "tool";
    content: string;
    toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  }>;
  toolCalls: ToolCall[];
  needsConfirmation: boolean;
  pending: Pending | null;
}

export interface ControlRow {
  solicitud_id: string;
  resultado: "CREADA" | "BLOQUEADA" | "PENDIENTE_CONFIRMACION" | "ERROR";
  numero_oc: string;
  retroactiva: boolean;
  bloqueos: string;
  confirmaciones: string;
  ts: string;
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const respuesta = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const texto = await respuesta.text();
  let data: unknown;
  try {
    data = JSON.parse(texto);
  } catch {
    throw new Error(`El servidor devolvió una respuesta no JSON (${respuesta.status}).`);
  }
  if (!respuesta.ok) {
    const error = (data as { error?: string }).error;
    throw new Error(error || `Error ${respuesta.status}`);
  }
  return data as T;
}

export function getHealth(): Promise<Health> {
  return apiFetch<Health>("/api/health");
}

export function getCases(): Promise<{ ok: boolean; data: CaseSummary[] }> {
  return apiFetch<{ ok: boolean; data: CaseSummary[] }>("/api/cases");
}

export function getControl(): Promise<{ ok: boolean; data: ControlRow[] }> {
  return apiFetch<{ ok: boolean; data: ControlRow[] }>("/api/out/control");
}

export function getSession(sessionId: string): Promise<SessionResponse> {
  return apiFetch<SessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export function enviarMensaje(
  sessionId: string,
  message: string,
): Promise<ChatResponse> {
  return apiFetch<ChatResponse>("/api/chat", {
    method: "POST",
    body: JSON.stringify({ sessionId, message }),
  });
}

export function resetSession(sessionId: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/reset`,
    { method: "POST" },
  );
}
