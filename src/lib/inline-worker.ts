import { getDB } from "./db";
import { tick } from "@/workers/processor";
const globalWorker = globalThis as typeof globalThis & {
  techviewWorker?: boolean;
};
export function ensureInlineWorker() {
  if (
    process.env.DATABASE_MODE !== "local" ||
    process.env.LOCAL_INLINE_WORKER !== "true" ||
    globalWorker.techviewWorker
  )
    return;
  globalWorker.techviewWorker = true;
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tick(await getDB());
    } catch (e) {
      console.error("inline_worker", e instanceof Error ? e.message : "Falha");
    } finally {
      busy = false;
    }
  }, 1000).unref();
}
