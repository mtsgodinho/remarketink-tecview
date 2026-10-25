import { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs/promises";
import path from "node:path";
import type { Row } from "@/types";
export interface DB {
  exec(sql: string): Promise<void>;
  close?: () => Promise<void>;
  query<T extends Row = Row>(
    sql: string,
    params?: any[],
  ): Promise<{ rows: T[] }>;
  transaction<T>(fn: (db: DB) => Promise<T>): Promise<T>;
}
const dbGlobal = globalThis as typeof globalThis & { techviewDB?: Promise<DB> };
export async function createLocal(location?: string): Promise<DB> {
  const pg = new PGlite(location);
  const wrap = (client: any): DB => ({
    query: (sql, params = []) => client.query(sql, params),
    exec: async (sql) => {
      await client.exec(sql);
    },
    transaction: (fn) => client.transaction((tx: any) => fn(wrap(tx))),
  });
  await pg.waitReady;
  return { ...wrap(pg), close: () => pg.close() };
}
export async function migrate(db: DB) {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const file of (
    await fs.readdir(path.join(process.cwd(), "supabase/migrations"))
  )
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (
      (
        await db.query(
          "SELECT version FROM schema_migrations WHERE version=$1",
          [file],
        )
      ).rows.length
    )
      continue;
    const sql = await fs.readFile(
      path.join(process.cwd(), "supabase/migrations", file),
      "utf8",
    );
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("INSERT INTO schema_migrations(version) VALUES($1)", [
        file,
      ]);
    });
  }
}
export async function getDB(): Promise<DB> {
  if (!dbGlobal.techviewDB)
    dbGlobal.techviewDB = (async () => {
      if (process.env.DATABASE_MODE === "local") {
        if (
          process.env.NODE_ENV === "production" &&
          process.env.AUTH_MODE === "local"
        )
          throw new Error("Autenticação local não é permitida em produção.");
        const db = await createLocal(
          path.resolve(
            /* turbopackIgnore: true */ process.env.LOCAL_DATABASE_PATH ||
              ".data/local-db",
          ),
        );
        await migrate(db);
        return db;
      }
      if (!process.env.DATABASE_URL)
        throw new Error(
          "Configure DATABASE_URL do Supabase e execute as migrations.",
        );
      const url = new URL(process.env.DATABASE_URL);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      for (const key of [
        "sslmode",
        "sslcert",
        "sslkey",
        "sslrootcert",
        "uselibpqcompat",
      ])
        url.searchParams.delete(key);
      const pool = new Pool({
        connectionString: url.toString(),
        ssl: local
          ? undefined
          : {
              rejectUnauthorized: true,
              ...(process.env.DATABASE_CA_CERT
                ? { ca: process.env.DATABASE_CA_CERT }
                : {}),
            },
        max: 5,
        connectionTimeoutMillis: 10000,
      });
      const db: DB = {
        query: (sql, p) => pool.query(sql, p),
        exec: async (sql) => {
          await pool.query(sql);
        },
        transaction: async (fn) => {
          const c = await pool.connect();
          try {
            await c.query("BEGIN");
            const v = await fn({
              query: (s, p) => c.query(s, p),
              exec: async (sql) => {
                await c.query(sql);
              },
              transaction: () => {
                throw Error("Transação aninhada");
              },
            });
            await c.query("COMMIT");
            return v;
          } catch (e) {
            await c.query("ROLLBACK");
            throw e;
          } finally {
            c.release();
          }
        },
      };
      return db;
    })().catch((e) => {
      dbGlobal.techviewDB = undefined;
      throw e;
    });
  return dbGlobal.techviewDB;
}
