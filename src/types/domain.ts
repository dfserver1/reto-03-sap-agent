export type Moneda = "COP" | "USD";
export type Unidad = "UN" | "H" | "MES";

export interface Solicitud {
  solicitud_id: string;
  solicitante: string;
  proveedor_nombre: string;
  proveedor_nit?: string;
  descripcion: string;
  centro_costo: string;
  subarea: string;
  cantidad: number;
  valor_unitario: number;
  valor_total: number;
  moneda: Moneda;
  indicador_iva?: string;
  condiciones_pago?: string;
  fecha_solicitud: string;
}

export interface Correo {
  id: string;
  de: string;
  para?: string;
  asunto: string;
  fecha: string;
  cuerpo: string;
  adjuntos?: string[];
}

export interface ItemCotizacion {
  descripcion: string;
  cantidad: number;
  precio_unitario: number;
  subtotal: number;
}

export interface Cotizacion {
  proveedor: string;
  nit: string | null;
  total: number;
  moneda: string;
  validez_hasta: string | null;
  texto: string;
  referencia: string | null;
  fecha: string | null;
  items: ItemCotizacion[];
}

export interface Aprobacion {
  de: string;
  para?: string;
  asunto?: string;
  fecha: string;
  aprobado: boolean;
  texto: string;
}

export interface Factura {
  numero: string;
  fecha: string;
  total: number;
}

export interface Paquete {
  correo: Correo;
  solicitud: Solicitud;
  cotizacion: Cotizacion | null;
  aprobacion: Aprobacion | null;
  factura: Factura | null;
  /** Adjuntos opcionales que no venían en el paquete, por nombre de archivo. */
  faltantes?: string[];
}

export interface Proveedor {
  codigo_sap: string;
  nit: string;
  nombre: string;
  condiciones_pago_default: string;
  indicador_iva_default: string;
  activo: boolean;
}

export interface Aprobador {
  email: string;
  nombre: string;
  tope: number;
}

export interface CentroCosto {
  centro_costo: string;
  nombre: string;
  subareas: string[];
  aprobadores: Aprobador[];
}

export interface IndicadorIva {
  codigo: string;
  descripcion: string;
  tasa: number;
}

export interface CondicionPago {
  codigo: string;
  descripcion: string;
  dias: number;
}

export interface Maestros {
  proveedores: Proveedor[];
  centrosCosto: CentroCosto[];
  indicadoresIva: IndicadorIva[];
  condicionesPago: CondicionPago[];
}

export interface Bloqueo {
  codigo: string;
  mensaje: string;
  accion_sugerida: string;
}

export interface Confirmacion {
  codigo: string;
  mensaje: string;
  valores?: Record<string, string | number | boolean | null>;
}

export interface Derivados {
  proveedor?: { codigo_sap: string; nit: string; nombre: string };
  aprobador?: { email: string; nombre: string; tope: number };
  indicador_iva?: string;
  condiciones_pago?: string;
  unidad?: Unidad;
  [key: string]: unknown;
}

export interface Validacion {
  apta: boolean;
  bloqueos: Bloqueo[];
  confirmaciones: Confirmacion[];
  derivados: Derivados;
  retroactiva: boolean;
}

export interface OrdenCompra {
  referencia: {
    solicitud_id: string;
    correo_id: string;
    cotizacion_ref: string | null;
  };
  sociedad: "1000";
  organizacion_compras: "1000";
  proveedor: { codigo_sap: string; nit: string; nombre: string };
  moneda: Moneda;
  condiciones_pago: string;
  aprobador: { email: string; fecha_aprobacion: string; evidencia_sha256: string };
  posiciones: Array<{
    numero: number;
    descripcion: string;
    cantidad: number;
    unidad: Unidad;
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

export interface ContextoHerramienta {
  directory: string;
  sessionId: string;
  /** Caso permitido para la sesión activa; las herramientas solo aceptan ese caso. */
  casoPermitido?: string;
}

export interface ToolOk<T> {
  ok: true;
  data: T;
}

export interface ToolError {
  ok: false;
  error: string;
  codigo?: string;
}

export type ToolResult<T> = ToolOk<T> | ToolError;
