import { app } from "../src/server";

// Vercel monta este catch-all en /api/*. El servidor Express conserva sus
// rutas (/api/chat, /api/health, /api/sessions/:id, ...).
export default app;
