/**
 * Schedule sources — what a schedule routine actually runs (Inbox v2 §3).
 *
 * A schedule routine's `trigger_config.source` names one entry here. No real
 * integration exists yet; they arrive in later build steps, each as a source
 * that fetches papers and saves them as raw source records. Until then the
 * registry holds `noop`, which records the run and fetches nothing.
 *
 * Contract for real sources: `run` owns its own org-context transactions for
 * anything it saves, and returns the new cursor only AFTER the raw papers are
 * saved — the handler persists it, so a crash before that re-fetches, and the
 * source's own dedupe (idempotent saves) absorbs the repeat.
 */
import type { SerializableJson } from "@/lib/serializable-json";

export interface ScheduleSourceRunInput {
  organizationId: string;
  routineId: string;
  /** The routine's persisted cursor, as of this run's start. */
  cursor: string | null;
  /** The slot this run was claimed for. */
  scheduledFor: Date;
}

export interface ScheduleSourceRunResult {
  /** The cursor to persist; omit to leave it unchanged. */
  cursor?: string | null;
  /** Recorded on the run's workflow event. */
  summary: Record<string, SerializableJson>;
}

export interface ScheduleSource {
  label: string;
  run(input: ScheduleSourceRunInput): Promise<ScheduleSourceRunResult>;
}

export const SCHEDULE_SOURCES: Record<string, ScheduleSource> = {
  noop: {
    label: "No-op (records the run, fetches nothing)",
    run: async () => ({ summary: { fetched: 0 } }),
  },
};

export function getScheduleSource(key: string): ScheduleSource | null {
  return Object.hasOwn(SCHEDULE_SOURCES, key) ? SCHEDULE_SOURCES[key] : null;
}
