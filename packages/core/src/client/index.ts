import type { Schema, Status } from "@/internal/types.js";
import type { ReadonlyDrizzle } from "@/types/db.js";
import { decodeCheckpoint } from "@/utils/checkpoint.js";
import { promiseWithResolvers } from "@/utils/promiseWithResolvers.js";
import type { QueryWithTypings } from "drizzle-orm";
import type { PgSession } from "drizzle-orm/pg-core";
import { createMiddleware } from "hono/factory";
import { streamSSE } from "hono/streaming";
import superjson from "superjson";
import { validateQuery } from "./parse.js";

/**
 * Middleware for `@ponder/client`.
 *
 * @param db - Drizzle database instance
 * @param schema - Ponder schema
 *
 * @example
 * ```ts
 * import { db } from "ponder:api";
 * import schema from "ponder:schema";
 * import { Hono } from "hono";
 * import { client } from "ponder";
 *
 * const app = new Hono();
 *
 * app.use("/sql/*", client({ db, schema }));
 *
 * export default app;
 * ```
 */
export const client = ({
  db,
}: { db: ReadonlyDrizzle<Schema>; schema: Schema }) => {
  // @ts-ignore
  const session: PgSession = db._.session;
  const driver = globalThis.PONDER_DATABASE.driver;
  let statusResolver = promiseWithResolvers<void>();

  const channel = `${globalThis.PONDER_NAMESPACE_BUILD.schema}_status_channel`;

  if ("instance" in driver) {
    driver.instance.query(`LISTEN "${channel}"`).then(() => {
      driver.instance.onNotification(async () => {
        statusResolver.resolve();
        statusResolver = promiseWithResolvers();
      });
    });
  } else {
    const pool = driver.internal;

    const connectAndListen = async () => {
      driver.listen = await pool.connect();

      await driver.listen.query(`LISTEN "${channel}"`);

      driver.listen.on("error", async () => {
        driver.listen?.release();
        await connectAndListen();
      });

      driver.listen.on("notification", () => {
        statusResolver.resolve();
        statusResolver = promiseWithResolvers();
      });
    };

    connectAndListen();
  }

  return createMiddleware(async (c, next) => {
    if (c.req.path === "/sql/db") {
      const queryString = c.req.query("sql");
      if (queryString === undefined) {
        return c.text('Missing "sql" query parameter', 400);
      }
      const query = superjson.parse(queryString) as QueryWithTypings;

      if ("instance" in driver) {
        try {
          await validateQuery(query.sql);
          const result = await session
            .prepareQuery(query, undefined, undefined, false)
            .execute();
          return c.json(result as object);
        } catch (error) {
          (error as Error).stack = undefined;
          return c.text((error as Error).message, 500);
        }
      } else {
        const client = await driver.internal.connect();

        try {
          await validateQuery(query.sql);
          await client.query("BEGIN READ ONLY");
          const result = await session
            .prepareQuery(query, undefined, undefined, false)
            .execute();
          return c.json(result as object);
        } catch (error) {
          (error as Error).stack = undefined;
          return c.text((error as Error).message, 500);
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      }
    }

    if (c.req.path === "/sql/live") {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      return streamSSE(c, async (stream) => {
        while (stream.closed === false && stream.aborted === false) {
          try {
            await stream.writeSSE({ data: "" });
          } catch {}
          await statusResolver.promise;
        }
      });
    }

    if (c.req.path === "/sql/status") {
      const checkpoints = await globalThis.PONDER_DATABASE.getCheckpoints();

      const status: Status = {};
      for (const { chainName, chainId, latestCheckpoint } of checkpoints) {
        status[chainName] = {
          id: chainId,
          block: {
            number: Number(decodeCheckpoint(latestCheckpoint).blockNumber),
            timestamp: Number(
              decodeCheckpoint(latestCheckpoint).blockTimestamp,
            ),
          },
        };
      }

      return c.json(status);
    }

    return next();
  });
};
