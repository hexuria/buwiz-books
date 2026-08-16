import type postgres from "postgres";
import { createQueryClient } from "@/db";
import { createLogger } from "@/lib/logger";
import { BUSINESS_GROUP_PROJECTION_JOB_TYPE } from "@/lib/reporting/projection";
import { triggerWorker } from "./trigger";

const logger = createLogger("jobs.projection-listener");
let listener: ReturnType<typeof createQueryClient> | null = null;
let listenRequest: postgres.ListenRequest | null = null;

/**
 * LISTEN/NOTIFY is only a latency hint. The processing_jobs row and the
 * scheduler remain the durable delivery mechanism if this connection drops.
 */
export function startProjectionNotificationListener(): void {
  if (listener || process.env.NODE_ENV === "test") return;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return;

  listener = createQueryClient(connectionString);
  listenRequest = listener.listen(
    "business_group_projection_dirty",
    () => triggerWorker([BUSINESS_GROUP_PROJECTION_JOB_TYPE]),
    () => logger.info("Business Group projection notification listener started"),
  );
  void listenRequest.catch((error: unknown) => {
    logger.warn("Business Group projection notification listener failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function stopProjectionNotificationListener(): Promise<void> {
  if (!listener) return;
  try {
    const active = await listenRequest;
    await active?.unlisten();
  } finally {
    await listener.end({ timeout: 1 });
    listener = null;
    listenRequest = null;
  }
}
