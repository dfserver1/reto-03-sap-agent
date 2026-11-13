import { limpiarOut } from "../src/lib/audit";

async function main(): Promise<void> {
  const directory = process.cwd();
  await limpiarOut(directory);
  console.log("out/ limpiado y recreado.");
}

main().catch((error) => {
  console.error("No se pudo limpiar out/:", error);
  process.exitCode = 1;
});
