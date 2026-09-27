/**
 * computeNextRunAt — schedule presets (Inbox v2 §3, build step 5).
 *
 * Pure and DST-correct. The load-bearing properties:
 *   - strictly after `from`, so a claimed slot always advances;
 *   - a daily/weekly slot inside a fall-back overlap fires ONCE (earlier
 *     instant), never twice in a day;
 *   - a slot inside a spring-forward gap still fires that day, shifted
 *     forward by the gap, never skipped;
 *   - hourly fires every real hour, the repeated hour included.
 * America/New_York 2026: DST starts Mar 8 07:00Z, ends Nov 1 06:00Z.
 * Asia/Manila is UTC+8 all year.
 */
import { describe, expect, it } from "vitest";
import {
  computeNextRunAt,
  scheduleConfigSchema,
  type ScheduleConfig,
} from "@/lib/routines/schedule";

const iso = (value: string) => new Date(value);

function series(config: ScheduleConfig, from: string, count: number): string[] {
  const out: string[] = [];
  let cursor = iso(from);
  for (let index = 0; index < count; index += 1) {
    cursor = computeNextRunAt(config, cursor);
    out.push(cursor.toISOString());
  }
  return out;
}

function wallClock(instant: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => parts.find((candidate) => candidate.type === type)!.value;
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

describe("computeNextRunAt", () => {
  describe("daily", () => {
    const manila: ScheduleConfig = { preset: "daily", at: "06:00", timezone: "Asia/Manila" };

    it("fires at the wall-clock time in the routine's zone", () => {
      // 05:00 Manila → 06:00 the same day; 08:00 Manila → 06:00 tomorrow.
      expect(computeNextRunAt(manila, iso("2026-09-26T21:00:00Z")).toISOString()).toBe(
        "2026-09-26T22:00:00.000Z",
      );
      expect(computeNextRunAt(manila, iso("2026-09-27T00:00:00Z")).toISOString()).toBe(
        "2026-09-27T22:00:00.000Z",
      );
    });

    it("is strictly after `from`, so a slot claimed on time advances a full day", () => {
      expect(computeNextRunAt(manila, iso("2026-09-26T22:00:00Z")).toISOString()).toBe(
        "2026-09-27T22:00:00.000Z",
      );
      expect(computeNextRunAt(manila, iso("2026-09-26T21:59:59.999Z")).toISOString()).toBe(
        "2026-09-26T22:00:00.000Z",
      );
    });

    it("resumes at the next future slot after missed days — no backfill storm", () => {
      // Three days late: the next slot is the next future one, not the missed ones.
      expect(computeNextRunAt(manila, iso("2026-09-30T03:00:00Z")).toISOString()).toBe(
        "2026-09-30T22:00:00.000Z",
      );
    });

    it("defaults to midnight when no time is given", () => {
      expect(
        computeNextRunAt(
          { preset: "daily", timezone: "Asia/Manila" },
          iso("2026-09-27T00:00:00Z"),
        ).toISOString(),
      ).toBe("2026-09-27T16:00:00.000Z");
    });

    it("keeps 06:00 local across spring-forward (a 23-hour gap between runs)", () => {
      expect(
        series(
          { preset: "daily", at: "06:00", timezone: "America/New_York" },
          "2026-03-06T12:00:00Z",
          3,
        ),
      ).toEqual([
        "2026-03-07T11:00:00.000Z",
        "2026-03-08T10:00:00.000Z",
        "2026-03-09T10:00:00.000Z",
      ]);
    });

    it("keeps 06:00 local across fall-back (a 25-hour gap between runs)", () => {
      expect(
        series(
          { preset: "daily", at: "06:00", timezone: "America/New_York" },
          "2026-10-31T00:00:00Z",
          3,
        ),
      ).toEqual([
        "2026-10-31T10:00:00.000Z",
        "2026-11-01T11:00:00.000Z",
        "2026-11-02T11:00:00.000Z",
      ]);
    });

    it("runs a slot inside the spring-forward gap, shifted forward — never skips the day", () => {
      // 02:30 does not exist on Mar 8 in New York; it runs at 03:30 EDT.
      expect(
        series(
          { preset: "daily", at: "02:30", timezone: "America/New_York" },
          "2026-03-07T12:00:00Z",
          3,
        ),
      ).toEqual([
        "2026-03-08T07:30:00.000Z",
        "2026-03-09T06:30:00.000Z",
        "2026-03-10T06:30:00.000Z",
      ]);
    });

    it("runs a slot inside the fall-back overlap once, at the earlier instant", () => {
      // 01:30 happens twice on Nov 1 (EDT 05:30Z, then EST 06:30Z). One run.
      expect(
        series(
          { preset: "daily", at: "01:30", timezone: "America/New_York" },
          "2026-10-31T12:00:00Z",
          3,
        ),
      ).toEqual([
        "2026-11-01T05:30:00.000Z",
        "2026-11-02T06:30:00.000Z",
        "2026-11-03T06:30:00.000Z",
      ]);
    });

    it("fires exactly once per local day for a whole year of New York DST", () => {
      for (const at of ["00:00", "01:30", "02:30", "06:00", "23:59"]) {
        const config: ScheduleConfig = { preset: "daily", at, timezone: "America/New_York" };
        // 23:59 on Dec 31 local, so every `at` first fires on Jan 1.
        const runs = series(config, "2026-01-01T04:59:00Z", 365).map((value) =>
          wallClock(new Date(value), "America/New_York"),
        );
        const dates = runs.map(({ date }) => date);
        expect(new Set(dates).size, at).toBe(365);
        expect(dates[0], at).toBe("2026-01-01");
        expect(dates[364], at).toBe("2026-12-31");
        for (const { date, time } of runs) {
          // Only the nonexistent 02:30 on the spring-forward day moves.
          const expected = at === "02:30" && date === "2026-03-08" ? "03:30" : at;
          expect(time, `${at} on ${date}`).toBe(expected);
        }
      }
    });
  });

  describe("hourly", () => {
    it("fires every real hour through fall-back, the repeated hour included", () => {
      expect(
        series({ preset: "hourly", timezone: "America/New_York" }, "2026-11-01T04:30:00Z", 4),
      ).toEqual([
        "2026-11-01T05:00:00.000Z", // 01:00 EDT
        "2026-11-01T06:00:00.000Z", // 01:00 EST — the repeated hour
        "2026-11-01T07:00:00.000Z", // 02:00 EST
        "2026-11-01T08:00:00.000Z",
      ]);
    });

    it("fires every real hour through spring-forward at the configured minute", () => {
      expect(
        series(
          { preset: "hourly", at: "00:15", timezone: "America/New_York" },
          "2026-03-08T06:00:00Z",
          3,
        ),
      ).toEqual([
        "2026-03-08T06:15:00.000Z", // 01:15 EST
        "2026-03-08T07:15:00.000Z", // 03:15 EDT — 02:xx never happens
        "2026-03-08T08:15:00.000Z",
      ]);
    });

    it("counts 23 runs on the short day and 25 on the long day", () => {
      const count = (start: string, end: string) =>
        series({ preset: "hourly", timezone: "America/New_York" }, start, 30).filter(
          (value) => new Date(value) < new Date(end),
        ).length;
      // Local midnight to local midnight.
      expect(count("2026-03-08T04:59:00Z", "2026-03-09T04:00:00Z")).toBe(23);
      expect(count("2026-11-01T03:59:00Z", "2026-11-02T05:00:00Z")).toBe(25);
    });

    it("uses only the minutes of `at` and honours half-hour zones", () => {
      // Asia/Kolkata is UTC+05:30: :00 local is :30 UTC.
      expect(
        computeNextRunAt(
          { preset: "hourly", at: "06:00", timezone: "Asia/Kolkata" },
          iso("2026-09-27T10:05:00Z"),
        ).toISOString(),
      ).toBe("2026-09-27T10:30:00.000Z");
    });

    it("survives a 30-minute DST shift (Lord Howe Island)", () => {
      // Apr 5 2026 02:00 LHDT (+11) falls back to 01:30 LHST (+10:30):
      // after 01:00 LHDT the next :00 is 02:00 LHST, 90 real minutes later.
      expect(
        computeNextRunAt(
          { preset: "hourly", timezone: "Australia/Lord_Howe" },
          iso("2026-04-04T14:00:00Z"),
        ).toISOString(),
      ).toBe("2026-04-04T15:30:00.000Z");
    });
  });

  describe("weekly", () => {
    it("fires on the configured weekday in the routine's zone", () => {
      const monday9: ScheduleConfig = {
        preset: "weekly",
        at: "09:00",
        weekday: 1,
        timezone: "Asia/Manila",
      };
      // Sunday 27 Sep 2026 → Monday 28 Sep 09:00 Manila.
      expect(computeNextRunAt(monday9, iso("2026-09-27T04:00:00Z")).toISOString()).toBe(
        "2026-09-28T01:00:00.000Z",
      );
      // On the slot itself → a week later.
      expect(computeNextRunAt(monday9, iso("2026-09-28T01:00:00Z")).toISOString()).toBe(
        "2026-10-05T01:00:00.000Z",
      );
    });

    it("uses the local weekday, not the UTC one", () => {
      // 00:30 Monday in Manila is still Sunday in UTC.
      expect(
        computeNextRunAt(
          { preset: "weekly", at: "00:30", weekday: 1, timezone: "Asia/Manila" },
          iso("2026-09-27T00:00:00Z"),
        ).toISOString(),
      ).toBe("2026-09-27T16:30:00.000Z");
    });

    it("stays on local time across both New York transitions", () => {
      // Sundays: Mar 8 (spring-forward day) and Nov 1 (fall-back day).
      expect(
        series(
          { preset: "weekly", at: "02:30", weekday: 0, timezone: "America/New_York" },
          "2026-03-01T12:00:00Z",
          2,
        ),
      ).toEqual(["2026-03-08T07:30:00.000Z", "2026-03-15T06:30:00.000Z"]);
      expect(
        series(
          { preset: "weekly", at: "01:30", weekday: 0, timezone: "America/New_York" },
          "2026-10-25T12:00:00Z",
          2,
        ),
      ).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-08T06:30:00.000Z"]);
    });
  });

  describe("validation", () => {
    it("rejects configurations that cannot mean one thing", () => {
      const bad: unknown[] = [
        { preset: "weekly", at: "09:00", timezone: "Asia/Manila" },
        { preset: "daily", at: "09:00", weekday: 1, timezone: "Asia/Manila" },
        { preset: "daily", at: "24:00", timezone: "Asia/Manila" },
        { preset: "daily", at: "6:00", timezone: "Asia/Manila" },
        { preset: "daily", at: "06:00", timezone: "Mars/Olympus_Mons" },
        { preset: "daily", at: "06:00" },
        { preset: "monthly", at: "06:00", timezone: "Asia/Manila" },
        { preset: "weekly", at: "06:00", weekday: 7, timezone: "Asia/Manila" },
      ];
      for (const config of bad) {
        expect(scheduleConfigSchema.safeParse(config).success, JSON.stringify(config)).toBe(false);
        expect(() =>
          computeNextRunAt(config as ScheduleConfig, iso("2026-09-27T00:00:00Z")),
        ).toThrow();
      }
    });

    it("canonicalizes the zone name", () => {
      expect(
        scheduleConfigSchema.parse({ preset: "daily", timezone: "asia/manila" }).timezone,
      ).toBe("Asia/Manila");
    });
  });
});
