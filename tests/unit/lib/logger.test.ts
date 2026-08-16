import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "../../../src/lib/logger";

describe("Structured Logger", () => {
  let consoleSpy: {
    debug: ReturnType<typeof vi.spyOn>;
    info: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    consoleSpy = {
      debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should create a logger with the given scope", () => {
    const logger = createLogger("test.scope");
    expect(logger).toHaveProperty("debug");
    expect(logger).toHaveProperty("info");
    expect(logger).toHaveProperty("warn");
    expect(logger).toHaveProperty("error");
  });

  it("should emit JSON to console.info on info()", () => {
    const logger = createLogger("api.auth");
    logger.info("User logged in", { userId: "u-1" });

    expect(consoleSpy.info).toHaveBeenCalledOnce();
    const payload = JSON.parse(consoleSpy.info.mock.calls[0][0]);
    expect(payload.level).toBe("info");
    expect(payload.scope).toBe("api.auth");
    expect(payload.message).toBe("User logged in");
    expect(payload.userId).toBe("u-1");
    expect(payload.ts).toBeTruthy();
  });

  it("should emit to console.debug on debug()", () => {
    const logger = createLogger("perf");
    logger.debug("Timing");
    expect(consoleSpy.debug).toHaveBeenCalledOnce();
  });

  it("should emit to console.warn on warn()", () => {
    const logger = createLogger("storage");
    logger.warn("Disk nearly full");
    expect(consoleSpy.warn).toHaveBeenCalledOnce();
  });

  it("should emit to console.error on error()", () => {
    const logger = createLogger("db");
    logger.error("Connection failed");
    expect(consoleSpy.error).toHaveBeenCalledOnce();
  });

  it("should normalize Error objects in metadata", () => {
    const logger = createLogger("handler");
    const err = new Error("Something broke");
    logger.error("Request failed", { error: err });

    const payload = JSON.parse(consoleSpy.error.mock.calls[0][0]);
    expect(payload.error).toEqual(
      expect.objectContaining({
        message: "Something broke",
        name: "Error",
      }),
    );
    expect(payload.error.stack).toBeTruthy();
  });

  it("should include a valid ISO timestamp", () => {
    const logger = createLogger("app");
    logger.info("Boot");

    const payload = JSON.parse(consoleSpy.info.mock.calls[0][0]);
    expect(() => new Date(payload.ts)).not.toThrow();
    expect(new Date(payload.ts).toISOString()).toBe(payload.ts);
  });

  it("should handle meta with no Error values", () => {
    const logger = createLogger("metrics");
    logger.info("Request complete", { duration: 42, path: "/api/test" });

    const payload = JSON.parse(consoleSpy.info.mock.calls[0][0]);
    expect(payload.duration).toBe(42);
    expect(payload.path).toBe("/api/test");
  });
});
