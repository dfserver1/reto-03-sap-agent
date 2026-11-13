import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { rateLimit, type RateLimitRequestHandler } from "express-rate-limit";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runTurn } from "./agent/loop";
import { leerControl, leerOrdenes } from "./lib/audit";
import { outDir, leerEvidencia } from "./lib/evidence";
import { listarResumenes } from "./lib/fixtures";
import {
  esIdSesionValido,
  obtenerSesion,
  reiniciarSesion,
  type PendienteConfirmacion,
} from "./lib/session";
import { crearAdapter } from "./llm";
import { PresupuestoAgotadoError, estadoPresupuesto, limiteTokensDiarios } from "./lib/budget";
import { redactar } from "./lib/redact";

const directory = process.cwd();
const adapter = crearAdapter();
const app = express();
const puerto = Number(process.env.PORT ?? 3001);
const confianzaProxy = Number(process.env.TRUST_PROXY ?? 1);
if (Number.isFinite(confianzaProxy) && confianzaProxy >= 0) {
  app.set("trust proxy", confianzaProxy);
}

const MAX_CONCURRENTES = Number(process.env.MAX_CONCURRENT_CHATS ?? 4);
let chatsActivos = 0;

app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameSrc: ["'none'"],
        mediaSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "no-referrer" },
    frameguard: { action: "deny" },
    hsts: false,
  }),
);
app.use(express.json({ limit: "256kb" }));
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

const origenesPermitidos = (process.env.APP_ORIGINS ?? "")
  .split(",")
  .map((origen) => origen.trim())
  .filter((origen) => origen !== "");

app.use((req: Request, res: Response, next: NextFunction) => {
  const origen = req.get("origin");
  if (origen && !origenesPermitidos.includes(origen)) {
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    res.status(403).json({ ok: false, error: "Origen no permitido." });
    return;
  }
  if (origen) {
    res.setHeader("Access-Control-Allow-Origin", origen);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  const metodosQueCambiaEstado = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  if (metodosQueCambiaEstado.has(req.method) && !esOrigenPermitido(req)) {
    res.status(403).json({ ok: false, error: "Origen no permitido." });
    return;
  }
  next();
});

const globalLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: (req) => req.path === "/health",
  handler: (_req, res) => {
    res.status(429).json({
      ok: false,
      error: "Demasiadas solicitudes en el periodo actual. Intenta de nuevo en un minuto.",
    });
  },
});

const chatLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      ok: false,
      error: "Demasiadas conversaciones en el periodo actual. Intenta de nuevo en un minuto.",
    });
  },
});

app.use("/api", globalLimiter);

app.get("/api/health", (_req: Request, res: Response) => {
  const presupuesto = estadoPresupuesto();
  res.json({
    ok: true,
    provider: adapter.name,
    model: adapter.model,
    determinista: adapter.determinista,
    presupuesto: {
      limite: presupuesto.limiteDiario,
      usados: presupuesto.usados,
      resetEn: presupuesto.fecha,
    },
  });
});

app.get("/api/cases", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const casos = await listarResumenes(directory);
    res.json({ ok: true, data: casos });
  } catch (error) {
    next(error);
  }
});

app.post("/api/chat", chatLimiter, async (req: Request, res: Response, next: NextFunction) => {
  if (chatsActivos >= MAX_CONCURRENTES) {
    res.status(429).json({
      ok: false,
      error: "Demasiadas conversaciones activas en este momento.",
    });
    return;
  }
  chatsActivos += 1;
  try {
    return await manejarChat(req, res);
  } catch (error) {
    next(error);
  } finally {
    chatsActivos -= 1;
  }
});

async function manejarChat(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { sessionId?: unknown; message?: unknown };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > 8000) {
    res.status(400).json({
      ok: false,
      error: "El campo message es obligatorio y debe tener entre 1 y 8000 caracteres.",
    });
    return;
  }

  const sessionId =
    typeof body.sessionId === "string" && body.sessionId.trim() !== ""
      ? body.sessionId.trim().slice(0, 100)
      : randomUUID();
  if (!esIdSesionValido(sessionId)) {
    res.status(400).json({ ok: false, error: "Identificador de sesión inválido." });
    return;
  }

  const sesion = obtenerSesion(sessionId);
  const resultado = await runTurn(sesion, message, { directory, sessionId }, adapter);

  res.json({
    ok: true,
    sessionId,
    reply: resultado.reply,
    toolCalls: resultado.toolCalls,
    needsConfirmation: resultado.needsConfirmation,
    pending: publicarPendiente(resultado.pending),
    tokensUsados: sesion.tokensUsados,
  });
}

app.get("/api/sessions/:id", (req, res) => {
  if (!esIdSesionValido(req.params.id)) {
    res.status(400).json({ ok: false, error: "Identificador de sesión inválido." });
    return;
  }
  const sesion = obtenerSesion(req.params.id);
  res.json({
    ok: true,
    sessionId: sesion.id,
    messages: sesion.messages,
    toolCalls: sesion.toolCalls,
    needsConfirmation: sesion.needsConfirmation,
    pending: publicarPendiente(sesion.pending),
    tokensUsados: sesion.tokensUsados,
  });
});

app.post("/api/sessions/:id/reset", (req, res) => {
  if (!esIdSesionValido(req.params.id)) {
    res.status(400).json({ ok: false, error: "Identificador de sesión inválido." });
    return;
  }
  reiniciarSesion(req.params.id);
  res.json({ ok: true, sessionId: req.params.id });
});

app.get("/api/out/control", async (_req, res) => {
  const filas = await leerControl(directory);
  res.json({ ok: true, data: filas });
});

app.get("/api/out/sap", async (_req, res) => {
  const ordenes = await leerOrdenes(directory);
  res.json({ ok: true, data: ordenes });
});

app.get("/api/out/evidence/:caso", async (req, res) => {
  const caso = req.params.caso;
  if (!/^sol-\d{3}$/.test(caso)) {
    res.status(400).json({ ok: false, error: "Caso inválido." });
    return;
  }
  const texto = await leerEvidencia(directory, caso);
  if (!texto) {
    res.status(404).json({ ok: false, error: "No hay evidencia generada para ese caso." });
    return;
  }
  res.type("text/plain; charset=utf-8").send(texto);
});

app.get("/api/out/trace/:caso", async (req, res) => {
  const caso = req.params.caso;
  if (!/^sol-\d{3}$/.test(caso)) {
    res.status(400).json({ ok: false, error: "Caso inválido." });
    return;
  }
  try {
    const texto = await readFile(path.join(outDir(directory), caso, "trazabilidad.json"), "utf8");
    res.type("application/json").send(texto);
  } catch {
    res.status(404).json({ ok: false, error: "No hay trazabilidad generada para ese caso." });
  }
});

const publicDir = path.join(directory, "public");
if (existsSync(publicDir)) {
  app.use(
    express.static(publicDir, {
      dotfiles: "deny",
      index: "index.html",
      fallthrough: true,
    }),
  );
}

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) {
    next();
    return;
  }
  const index = path.join(publicDir, "index.html");
  if (existsSync(index)) {
    res.sendFile(index);
    return;
  }
  res
    .status(200)
    .type("text/plain")
    .send(
      "API del agente de órdenes de compra. El front no está compilado: ejecuta `npm run build` o usa `npm run dev`.",
    );
});

app.use(
  (
    error: Error & { type?: string; status?: number; body?: unknown },
    _req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const esErrorProveedor = error instanceof PresupuestoAgotadoError;
    const status =
      error.type === "entity.too.large"
        ? 413
        : error.type === "entity.parse.failed"
          ? 400
          : error.status ?? 500;
    const mensaje =
      status >= 500
        ? "Error interno del servidor."
        : redactar(error.message) || "Error en la solicitud.";
    if (status >= 500) {
      console.error("Error interno del servidor:", redactar(error.message));
    }
    if (status === 429 && !esErrorProveedor) {
      res.status(429).json({
        ok: false,
        error: redactar(error.message) || "Demasiadas solicitudes. Intenta de nuevo.",
      });
      return;
    }
    res.status(status).json({ ok: false, error: mensaje });
  },
);

if (process.env.VERCEL !== "1") {
  const servidor = app.listen(puerto, () => {
    console.log(`Agente de compras escuchando en http://localhost:${puerto}`);
    console.log(`Proveedor LLM: ${adapter.name} (${adapter.model})`);
    console.log(`Directorio de trabajo: ${directory}`);
  });
  servidor.on("close", () => {
    console.log("Servidor HTTP cerrado.");
  });
  process.on("SIGTERM", () => {
    servidor.close(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    servidor.close(() => process.exit(0));
  });
}

function esOrigenPermitido(req: Request): boolean {
  const origen = req.get("origin");
  if (!origen) return true;
  if (origenesPermitidos.includes(origen)) return true;
  const host = req.get("host");
  if (!host) return false;
  const protocolo = (req.get("x-forwarded-proto") ?? req.protocol ?? "https")
    .split(",")
    .map((valor) => valor.trim())
    .filter(Boolean)[0];
  const origenNormalizado = origen.trim().toLowerCase();
  const hostNormalizado = host.trim().toLowerCase();
  const origenesPosibles = [protocolo, "http", "https"];
  const esperados = new Set<string>();
  for (const valor of origenesPosibles) {
    if (!valor) continue;
    esperados.add(`${valor.toLowerCase()}://${hostNormalizado}`);
  }
  return esperados.has(origenNormalizado);
}

function publicarPendiente(
  pendiente: PendienteConfirmacion | null | undefined,
): unknown {
  if (!pendiente) return null;
  return {
    caso: pendiente.caso,
    resumen: pendiente.resumen,
    confirmaciones: pendiente.validacion.confirmaciones,
    derivados: pendiente.validacion.derivados,
    retroactiva: pendiente.validacion.retroactiva,
    orden: pendiente.orden,
    evidencia: pendiente.evidencia ?? null,
  };
}

export { app };
