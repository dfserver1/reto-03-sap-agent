import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const AGENT_FRONTMATTER = `---
description: Agente conversacional para validar solicitudes y crear órdenes de compra en un SAP simulado. Usa las herramientas oc_* y exige confirmación humana cuando hay excepciones.
mode: primary
permission:
  edit: deny
  bash: deny
  webfetch: deny
---`;

const SKILL_FRONTMATTER = `---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia IT Group, controles RC1-RC10, tratamiento de compras retroactivas y payload SAP. Úsala cuando el agente deba leer, validar, construir o crear una OC.
---`;

async function main(): Promise<void> {
  const directory = process.cwd();
  const [prompt, conocimiento] = await Promise.all([
    readFile(path.join(directory, "agent", "prompt.md"), "utf8"),
    readFile(path.join(directory, "src", "knowledge", "ordenes-compra.md"), "utf8"),
  ]);

  const rutaAgente = path.join(directory, "modulo", "agent.md");
  const rutaSkill = path.join(
    directory,
    "modulo",
    "skill",
    "ordenes-compra",
    "SKILL.md",
  );
  const rutaTools = path.join(directory, "modulo", "tools", "oc.ts");

  await mkdir(path.dirname(rutaSkill), { recursive: true });
  await mkdir(path.dirname(rutaTools), { recursive: true });

  await writeFile(
    rutaAgente,
    `${AGENT_FRONTMATTER}\n\n<!-- Generado por scripts/sync-modulo.ts desde agent/prompt.md. No editar a mano. -->\n\n${prompt}`,
    "utf8",
  );

  await writeFile(
    rutaSkill,
    `${SKILL_FRONTMATTER}\n\n<!-- Generado por scripts/sync-modulo.ts desde src/knowledge/ordenes-compra.md. No editar a mano. -->\n\n${conocimiento}`,
    "utf8",
  );

  await writeFile(
    rutaTools,
    `// Reexporta exactamente las mismas herramientas que usa el servidor.\n// No es una copia: si cambia src/tools/oc.ts, el módulo cambia con él.\nexport * from "../../src/tools/oc";\n`,
    "utf8",
  );

  console.log("Módulo sincronizado:");
  console.log(`- ${path.relative(directory, rutaAgente)}`);
  console.log(`- ${path.relative(directory, rutaSkill)}`);
  console.log(`- ${path.relative(directory, rutaTools)}`);
}

main().catch((error) => {
  console.error("No se pudo sincronizar el módulo:", error);
  process.exitCode = 1;
});
