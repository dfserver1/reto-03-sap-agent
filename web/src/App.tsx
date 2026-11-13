import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  enviarMensaje,
  getCases,
  getControl,
  getHealth,
  getSession,
  resetSession,
  type CaseSummary,
  type Confirmacion,
  type ControlRow,
  type Health,
  type OrdenCompra,
  type Pending,
  type ToolCall,
} from "./api";

type RolMensaje = "user" | "assistant";

interface Mensaje {
  role: RolMensaje;
  content: string;
}

const ETIQUETAS_TOOL: Record<string, string> = {
  oc_leer_paquete: "Leer paquete",
  oc_validar: "Validar RC1–RC10",
  oc_construir_payload: "Construir payload",
  oc_generar_evidencia: "Generar evidencia",
  oc_crear: "Crear OC en SAP",
};

function nuevoId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `ses-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatearMoneda(valor: number, moneda = "COP"): string {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: moneda === "USD" ? "USD" : "COP",
    maximumFractionDigits: 0,
  }).format(valor);
}

function formatearHora(ts: string): string {
  if (!ts) return "—";
  const fecha = new Date(ts);
  if (Number.isNaN(fecha.getTime())) return ts;
  return fecha.toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function totalOrden(orden: OrdenCompra): number {
  return orden.posiciones.reduce(
    (total, posicion) => total + posicion.cantidad * posicion.precio_unitario,
    0,
  );
}

function casoDeTool(call: ToolCall): string | null {
  if (call.args && typeof call.args === "object" && "caso" in call.args) {
    const caso = (call.args as Record<string, unknown>).caso;
    if (typeof caso === "string") return caso;
  }
  return null;
}

function resumenTool(call: ToolCall): string {
  const resultado = call.result as {
    ok?: boolean;
    data?: unknown;
    error?: string;
    codigo?: string;
  };
  if (resultado.ok === false) {
    return resultado.error ?? "Error desconocido";
  }
  const data = resultado.data;
  switch (call.name) {
    case "oc_leer_paquete": {
      const d = data as {
        solicitud?: { solicitud_id?: string; proveedor_nombre?: string };
      };
      return `${d.solicitud?.solicitud_id ?? "—"} · ${d.solicitud?.proveedor_nombre ?? "—"}`;
    }
    case "oc_validar": {
      const d = data as {
        apta?: boolean;
        bloqueos?: Array<{ codigo: string }>;
        confirmaciones?: Array<{ codigo: string }>;
      };
      const bloqueos = (d.bloqueos ?? []).map((b) => b.codigo).join(", ") || "—";
      const confirmaciones =
        (d.confirmaciones ?? []).map((c) => c.codigo).join(", ") || "—";
      return `${d.apta ? "APTA" : "BLOQUEADA"} · bloqueos: ${bloqueos} · confirmaciones: ${confirmaciones}`;
    }
    case "oc_construir_payload": {
      const d = data as { orden?: OrdenCompra };
      if (!d.orden) return "Payload generado";
      return `${d.orden.referencia.solicitud_id} · ${d.orden.proveedor.nombre} · ${formatearMoneda(
        totalOrden(d.orden),
        d.orden.moneda,
      )}`;
    }
    case "oc_generar_evidencia": {
      const d = data as { sha256?: string; ruta?: string };
      return `${d.ruta ?? "evidencia"} · sha256 ${d.sha256?.slice(0, 12) ?? "—"}…`;
    }
    case "oc_crear": {
      const d = data as { numero_oc?: string; idempotente?: boolean };
      return `OC ${d.numero_oc ?? "—"}${d.idempotente ? " (idempotente)" : ""}`;
    }
    default:
      return "OK";
  }
}

function etiquetaResultado(resultado: ControlRow["resultado"]): {
  texto: string;
  tono: "ok" | "warn" | "danger" | "neutral";
} {
  switch (resultado) {
    case "CREADA":
      return { texto: "Creada", tono: "ok" };
    case "PENDIENTE_CONFIRMACION":
      return { texto: "Pendiente", tono: "warn" };
    case "BLOQUEADA":
      return { texto: "Bloqueada", tono: "danger" };
    default:
      return { texto: "Error", tono: "danger" };
  }
}

export function App() {
  const [sessionId, setSessionId] = useState<string>(() => {
    const guardada = localStorage.getItem("reto3-session");
    return guardada && guardada.trim() ? guardada : nuevoId();
  });
  const [health, setHealth] = useState<Health | null>(null);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [messages, setMessages] = useState<Mensaje[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [control, setControl] = useState<ControlRow[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorGlobal, setErrorGlobal] = useState<string | null>(null);
  const finMensajes = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    localStorage.setItem("reto3-session", sessionId);
  }, [sessionId]);

  useEffect(() => {
    let activo = true;
    Promise.all([getHealth(), getCases(), getControl()])
      .then(([salud, casos, log]) => {
        if (!activo) return;
        setHealth(salud);
        setCases(casos.data);
        setControl(log.data);
      })
      .catch((error) => {
        if (activo) setErrorGlobal((error as Error).message);
      });
    return () => {
      activo = false;
    };
  }, []);

  useEffect(() => {
    let activo = true;
    getSession(sessionId)
      .then((sesion) => {
        if (!activo) return;
        setToolCalls(sesion.toolCalls);
        setPending(sesion.pending);
        setNeedsConfirmation(sesion.needsConfirmation);
        const historial: Mensaje[] = sesion.messages
          .filter(
            (mensaje) =>
              mensaje.role === "user" ||
              (mensaje.role === "assistant" && mensaje.content.trim() !== ""),
          )
          .map((mensaje) => ({
            role: mensaje.role as RolMensaje,
            content: mensaje.content,
          }));
        setMessages(historial);
      })
      .catch(() => {
        if (activo) {
          setMessages([]);
          setToolCalls([]);
          setPending(null);
          setNeedsConfirmation(false);
        }
      });
    return () => {
      activo = false;
    };
  }, [sessionId]);

  useEffect(() => {
    finMensajes.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading, pending]);

  const refrescarControl = useCallback(async () => {
    try {
      const log = await getControl();
      setControl(log.data);
    } catch {
      // El log es informativo; no bloquea el chat.
    }
  }, []);

  const send = useCallback(
    async (texto: string) => {
      const limpio = texto.trim();
      if (!limpio || loading) return;

      setErrorGlobal(null);
      setInput("");
      setLoading(true);
      setMessages((prev) => [...prev, { role: "user", content: limpio }]);

      try {
        const data = await enviarMensaje(sessionId, limpio);
        if (data.sessionId && data.sessionId !== sessionId) {
          setSessionId(data.sessionId);
        }
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.reply },
        ]);
        setToolCalls((prev) => [...prev, ...data.toolCalls]);
        setPending(data.pending);
        setNeedsConfirmation(data.needsConfirmation);
        await refrescarControl();
      } catch (error) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `No pude completar el turno: ${(error as Error).message}`,
          },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [loading, refrescarControl, sessionId],
  );

  const nuevaSesion = useCallback(async () => {
    try {
      await resetSession(sessionId);
    } catch {
      // Si el servidor ya no conoce la sesión, igual creamos una nueva.
    }
    const id = nuevoId();
    setSessionId(id);
    setMessages([]);
    setToolCalls([]);
    setPending(null);
    setNeedsConfirmation(false);
    setInput("");
    setErrorGlobal(null);
  }, [sessionId]);

  const confirmar = useCallback(() => {
    void send("confirmo");
  }, [send]);

  const rechazar = useCallback(() => {
    void send("rechazo");
  }, [send]);

  const procesarCaso = useCallback(
    (caso: string) => {
      void send(`Procesa la solicitud ${caso}.`);
    },
    [send],
  );

  const validarCaso = useCallback(
    (caso: string) => {
      void send(`Valida ${caso} y muéstrame la OC sin crearla.`);
    },
    [send],
  );

  const ocCreada = useMemo(() => {
    const ultima = [...toolCalls]
      .reverse()
      .find((call) => call.name === "oc_crear" && call.ok);
    if (!ultima) return null;
    const data = (ultima.result as { data?: { numero_oc?: string; retroactiva?: boolean } })
      .data;
    return data?.numero_oc
      ? { numero: data.numero_oc, retroactiva: Boolean(data.retroactiva) }
      : null;
  }, [toolCalls]);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="brand-mark">OC</div>
          <div>
            <h1>Agente de Órdenes de Compra</h1>
            <p>Periferia IT Group · SAP simulado · Reto 03</p>
          </div>
        </div>
        <div className="header-actions">
          <span className={`badge ${health?.determinista ? "warn" : "ok"}`}>
            <span className="dot" />
            {health
              ? health.determinista
                ? "Modo determinista"
                : `${health.provider} · ${health.model}`
              : "Conectando…"}
          </span>
          <button className="btn ghost" onClick={() => void nuevaSesion()}>
            Nueva sesión
          </button>
        </div>
      </header>

      {errorGlobal && (
        <div className="global-error" role="alert">
          {errorGlobal}
          <button className="link" onClick={() => setErrorGlobal(null)}>
            cerrar
          </button>
        </div>
      )}

      <main className="layout">
        <aside className="panel sidebar">
          <div className="panel-title">
            <div>
              <h2>Casos de prueba</h2>
              <p>6 paquetes normalizados</p>
            </div>
            <span className="badge neutral">{cases.length}</span>
          </div>

          <div className="case-list">
            {cases.map((item) => (
              <CaseCard
                key={item.caso}
                item={item}
                loading={loading}
                onProcesar={() => procesarCaso(item.caso)}
                onValidar={() => validarCaso(item.caso)}
              />
            ))}
            {cases.length === 0 && (
              <p className="muted">
                No se pudieron cargar los casos. Revisa que exista
                <code> fixtures/reto-03/solicitudes/</code>.
              </p>
            )}
          </div>

          <div className="sidebar-note">
            <strong>Controles RC1–RC10</strong>
            <p>
              Proveedor, aprobador, tope, subárea, cotización, IVA, pago,
              retroactiva, fechas y coherencia de montos.
            </p>
          </div>
        </aside>

        <section className="panel chat-panel">
          <div className="chat-header">
            <div>
              <h2>Conversación</h2>
              <p>
                Sesión <code>{sessionId.slice(0, 8)}…</code>
              </p>
            </div>
            {ocCreada && (
              <span className="badge ok">
                OC {ocCreada.numero}
                {ocCreada.retroactiva ? " · retroactiva" : ""}
              </span>
            )}
          </div>

          <div className="messages">
            {messages.length === 0 && !loading && (
              <div className="welcome">
                <div className="welcome-icon">🛒</div>
                <h2>¿Qué compra quieres procesar?</h2>
                <p>
                  Elige un caso de la izquierda o escribe, por ejemplo:{" "}
                  <code>Procesa la solicitud sol-001</code>.
                </p>
                <div className="quick-actions">
                  {cases.slice(0, 3).map((item) => (
                    <button
                      key={item.caso}
                      className="quick"
                      onClick={() => procesarCaso(item.caso)}
                    >
                      {item.caso}
                    </button>
                  ))}
                </div>
                <p className="muted small">
                  Las llamadas a herramientas, los controles y las
                  confirmaciones aparecen en vivo.
                </p>
              </div>
            )}

            {messages.map((mensaje, indice) => (
              <div key={indice} className={`message ${mensaje.role}`}>
                <div className="bubble">
                  <span className="role">
                    {mensaje.role === "user" ? "Analista" : "Agente"}
                  </span>
                  <div className="content">{mensaje.content}</div>
                </div>
              </div>
            ))}

            {loading && (
              <div className="message assistant">
                <div className="bubble typing">
                  <span className="role">Agente</span>
                  <div className="typing-dots">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              </div>
            )}
            <div ref={finMensajes} />
          </div>

          {pending && needsConfirmation && (
            <ConfirmacionPanel
              pending={pending}
              loading={loading}
              onConfirmar={confirmar}
              onRechazar={rechazar}
            />
          )}

          <div className="composer">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send(input);
                }
              }}
              placeholder="Escribe 'Procesa la solicitud sol-001' o pide una validación…"
              rows={2}
              disabled={loading}
            />
            <button
              className="btn primary send"
              onClick={() => void send(input)}
              disabled={loading || input.trim() === ""}
            >
              {loading ? "…" : "Enviar"}
            </button>
          </div>
          <p className="composer-hint">
            Enter envía · Shift+Enter salto de línea · La OC nunca se crea sin
            las confirmaciones requeridas.
          </p>
        </section>

        <aside className="panel tools-panel">
          <div className="panel-title">
            <div>
              <h2>Llamadas a herramientas</h2>
              <p>trazabilidad en vivo</p>
            </div>
            <span className="badge neutral">{toolCalls.length}</span>
          </div>

          <div className="tool-list">
            {toolCalls.length === 0 && (
              <p className="muted">
                Aún no hay llamadas. Procesa un caso para ver
                <code> oc_leer_paquete</code>, <code>oc_validar</code> y las
                demás herramientas.
              </p>
            )}
            {[...toolCalls].reverse().map((call) => (
              <ToolCard key={call.id} call={call} />
            ))}
          </div>
        </aside>
      </main>

      <section className="panel control-panel">
        <div className="panel-title">
          <div>
            <h2>Log de control</h2>
            <p>
              Cada intento queda en <code>out/control.csv</code>; las OC
              retroactivas se marcan con <code>retroactiva=true</code>.
            </p>
          </div>
          <span className="badge neutral">{control.length} filas</span>
        </div>

        {control.length === 0 ? (
          <p className="muted">
            Aún no hay intentos registrados. Procesa un caso o ejecuta{" "}
            <code>npm run demo</code>.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Solicitud</th>
                  <th>Resultado</th>
                  <th>OC</th>
                  <th>Retroactiva</th>
                  <th>Bloqueos</th>
                  <th>Confirmaciones</th>
                  <th>Hora</th>
                </tr>
              </thead>
              <tbody>
                {[...control].reverse().slice(0, 12).map((fila, indice) => {
                  const estado = etiquetaResultado(fila.resultado);
                  return (
                    <tr key={`${fila.solicitud_id}-${fila.ts}-${indice}`}>
                      <td className="mono">{fila.solicitud_id}</td>
                      <td>
                        <span className={`badge ${estado.tono}`}>
                          {estado.texto}
                        </span>
                      </td>
                      <td className="mono">{fila.numero_oc || "—"}</td>
                      <td>
                        {fila.retroactiva ? (
                          <span className="badge danger">Sí</span>
                        ) : (
                          <span className="muted">No</span>
                        )}
                      </td>
                      <td className="mono">{fila.bloqueos || "—"}</td>
                      <td className="mono">{fila.confirmaciones || "—"}</td>
                      <td className="mono">{formatearHora(fila.ts)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer className="footer">
        <span>
          Demo determinista: <code>npm run demo</code>
        </span>
        <span>
          Documentación: <code>SOLUCION.md</code>
        </span>
        <span>
          Evidencia y log: <code>out/</code>
        </span>
      </footer>
    </div>
  );
}

function CaseCard({
  item,
  loading,
  onProcesar,
  onValidar,
}: {
  item: CaseSummary;
  loading: boolean;
  onProcesar: () => void;
  onValidar: () => void;
}) {
  return (
    <article className="case-card">
      <div className="case-top">
        <span className="case-id">{item.caso}</span>
        <span className="case-amount">
          {formatearMoneda(item.valor_total, item.moneda)}
        </span>
      </div>
      <div className="case-ref">
        <span className="mono">{item.solicitud_id}</span>
        <span>{item.proveedor_nombre || "—"}</span>
      </div>
      <p className="case-desc">{item.descripcion || item.error || "—"}</p>
      <div className="chips">
        <span className="chip">{item.centro_costo || "—"}</span>
        <span className="chip">{item.subarea || "—"}</span>
      </div>
      <div className="case-actions">
        <button className="btn primary small" onClick={onProcesar} disabled={loading}>
          Procesar
        </button>
        <button className="btn ghost small" onClick={onValidar} disabled={loading}>
          Validar
        </button>
      </div>
    </article>
  );
}

function ConfirmacionPanel({
  pending,
  loading,
  onConfirmar,
  onRechazar,
}: {
  pending: Pending;
  loading: boolean;
  onConfirmar: () => void;
  onRechazar: () => void;
}) {
  const orden = pending.orden;
  const total = totalOrden(orden);
  return (
    <div className="confirm-banner" role="alert">
      <div className="confirm-header">
        <span className="pulse" />
        <div>
          <h3>Confirmación humana requerida</h3>
          <p>
            Caso <strong>{pending.caso}</strong> · la OC no se crea hasta que
            confirmes.
          </p>
        </div>
      </div>

      <pre className="confirm-resumen">{pending.resumen}</pre>

      <div className="confirm-grid">
        <div>
          <span className="label">Proveedor</span>
          <strong>{orden.proveedor.nombre}</strong>
          <span className="mono small">
            {orden.proveedor.codigo_sap} · NIT {orden.proveedor.nit}
          </span>
        </div>
        <div>
          <span className="label">Referencia</span>
          <strong>{orden.referencia.solicitud_id}</strong>
          <span className="mono small">{orden.referencia.correo_id}</span>
        </div>
        <div>
          <span className="label">Condición de pago</span>
          <strong>{orden.condiciones_pago}</strong>
          <span className="mono small">IVA {orden.posiciones[0]?.indicador_iva}</span>
        </div>
        <div>
          <span className="label">Total</span>
          <strong>{formatearMoneda(total, orden.moneda)}</strong>
          <span className="muted small">
            {orden.posiciones[0]?.cantidad} {orden.posiciones[0]?.unidad} ×{" "}
            {formatearMoneda(orden.posiciones[0]?.precio_unitario ?? 0, orden.moneda)}
          </span>
        </div>
      </div>

      {pending.confirmaciones.length > 0 && (
        <ul className="confirm-list">
          {pending.confirmaciones.map((confirmacion: Confirmacion) => (
            <li key={confirmacion.codigo}>
              <span className="badge warn">{confirmacion.codigo}</span>
              {confirmacion.mensaje}
            </li>
          ))}
        </ul>
      )}

      <details className="payload-details">
        <summary>Ver payload completo y trazabilidad</summary>
        <pre>{JSON.stringify(orden, null, 2)}</pre>
        {pending.evidencia && (
          <p className="muted small">
            Evidencia: {pending.evidencia.ruta} · sha256{" "}
            {pending.evidencia.sha256.slice(0, 16)}…
          </p>
        )}
      </details>

      <div className="confirm-actions">
        <button className="btn primary" onClick={onConfirmar} disabled={loading}>
          Confirmo y creo la OC
        </button>
        <button className="btn danger" onClick={onRechazar} disabled={loading}>
          Rechazo
        </button>
      </div>
    </div>
  );
}

function ToolCard({ call }: { call: ToolCall }) {
  const caso = casoDeTool(call);
  const resultado = call.result as { ok?: boolean; error?: string };
  return (
    <article className={`tool-card ${call.ok ? "ok" : "fail"}`}>
      <div className="tool-head">
        <div>
          <strong>{ETIQUETAS_TOOL[call.name] ?? call.name}</strong>
          <span className="mono tool-name">{call.name}</span>
        </div>
        <div className="tool-meta">
          <span className={`badge ${call.ok ? "ok" : "danger"}`}>
            {call.ok ? "OK" : "Error"}
          </span>
          <span className="muted mono">{call.durationMs} ms</span>
        </div>
      </div>

      <p className="tool-summary">{resumenTool(call)}</p>
      {resultado.ok === false && (
        <p className="tool-error">{resultado.error ?? "Error desconocido"}</p>
      )}

      {caso && call.name === "oc_generar_evidencia" && call.ok && (
        <a
          className="btn ghost small evidence-link"
          href={`/api/out/evidence/${caso}`}
          target="_blank"
          rel="noreferrer"
        >
          Ver evidencia
        </a>
      )}

      <details>
        <summary>Argumentos</summary>
        <pre>{JSON.stringify(call.args, null, 2)}</pre>
      </details>
      <details>
        <summary>Resultado</summary>
        <pre>{JSON.stringify(call.result, null, 2)}</pre>
      </details>
    </article>
  );
}
