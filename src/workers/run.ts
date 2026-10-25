import "dotenv/config";
import { getDB } from "../lib/db";
import { tick } from "./processor";
if (process.env.DATABASE_MODE === "local")
  throw Error(
    "No modo local, use LOCAL_INLINE_WORKER=true no servidor web. Worker separado requer PostgreSQL.",
  );
const db = await getDB();
let active = true;
process.on("SIGTERM", () => (active = false));
process.on("SIGINT", () => (active = false));
console.log(
  "Worker iniciado. Nenhum envio real sem autorização de campanha e flags do servidor.",
);
while (active) {
  try {
    await tick(db);
  } catch (e) {
    console.error("worker_error", e instanceof Error ? e.message : "Falha");
  }
  await new Promise((r) => setTimeout(r, 1000));
}
process.exit(0);
