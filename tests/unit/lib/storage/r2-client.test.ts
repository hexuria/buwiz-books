import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateR2Key,
  isR2Configured,
  uploadToR2,
  getPresignedDownloadUrl,
  getPresignedUploadUrl,
  deleteFromR2,
  downloadFromR2,
  existsInR2,
  getR2Metadata,
} from "../../../../src/lib/storage/r2-client";
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// vi.hoisted() runs BEFORE any module imports, so we set env vars here
// to ensure r2-client.ts reads them into its module-level constants.
// This makes the test self-contained — no --env-file flag needed.
const { mockSend } = vi.hoisted(() => {
  process.env.R2_ENDPOINT = "https://mock.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "mock-access-key";
  process.env.R2_SECRET_ACCESS_KEY = "mock-secret-key";

  const mockSend = vi.fn();
  return { mockSend };
});

vi.mock("@aws-sdk/client-s3", () => {
  return {
    S3Client: class {
      send = mockSend;
    },
    PutObjectCommand: vi.fn(),
    GetObjectCommand: vi.fn(),
    DeleteObjectCommand: vi.fn(),
    HeadObjectCommand: vi.fn(),
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(),
}));

describe("R2 Client Unit Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- Pure functions (no SDK dependency) ----

  it("generateR2Key creates unique sanitized keys with org prefix", () => {
    const key = generateR2Key("org-123", "my invalid #file name!.pdf");
    expect(key).toMatch(/^org-123\/\d+-[a-f0-9]{8}-my_invalid__file_name_.pdf$/);
  });

  it("generateR2Key truncates long filenames to 100 chars", () => {
    const longName = "a".repeat(200) + ".pdf";
    const key = generateR2Key("org-1", longName);
    // Key format: {orgId}/{timestamp}-{uuid8}-{sanitizedFilename}
    // The sanitized filename is the last segment after the 8-char UUID and its trailing dash
    const afterOrgSlash = key.split("/")[1]; // {timestamp}-{uuid8}-{sanitized}
    // Find the sanitized part: skip "{timestamp}-{uuid8}-"
    const match = afterOrgSlash.match(/^\d+-[a-f0-9]{8}-(.+)$/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBeLessThanOrEqual(100);
  });

  it("isR2Configured returns true when env vars are set", () => {
    // This test relies on --env-file=.env.test providing the env vars at module load
    expect(isR2Configured()).toBe(true);
  });

  // ---- Upload ----

  it("uploadToR2 sends PutObjectCommand and returns key + bucket", async () => {
    mockSend.mockResolvedValueOnce({});

    const result = await uploadToR2("test-key", Buffer.from("test"), "text/plain");

    expect(result.r2Key).toBe("test-key");
    expect(result.r2Bucket).toBe("mvg");
    expect(PutObjectCommand).toHaveBeenCalledWith({
      Bucket: "mvg",
      Key: "test-key",
      Body: expect.any(Buffer),
      ContentType: "text/plain",
    });
  });

  // ---- Presigned URLs ----

  it("getPresignedDownloadUrl generates a signed download URL", async () => {
    (getSignedUrl as any).mockResolvedValueOnce("https://signed-url.com/download");

    const url = await getPresignedDownloadUrl("test-key", { expiresIn: 3600 });

    expect(url).toBe("https://signed-url.com/download");
    expect(GetObjectCommand).toHaveBeenCalledWith({
      Bucket: "mvg",
      Key: "test-key",
    });
    expect(getSignedUrl).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), {
      expiresIn: 3600,
    });
  });

  it("getPresignedUploadUrl generates a signed upload URL", async () => {
    (getSignedUrl as any).mockResolvedValueOnce("https://signed-url.com/upload");

    const url = await getPresignedUploadUrl("test-key", "image/png", { expiresIn: 7200 });

    expect(url).toBe("https://signed-url.com/upload");
    expect(PutObjectCommand).toHaveBeenCalledWith({
      Bucket: "mvg",
      Key: "test-key",
      ContentType: "image/png",
    });
    expect(getSignedUrl).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), {
      expiresIn: 7200,
    });
  });

  // ---- Delete ----

  it("deleteFromR2 handles successful deletion", async () => {
    mockSend.mockResolvedValueOnce({});

    await expect(deleteFromR2("test-key")).resolves.not.toThrow();

    expect(DeleteObjectCommand).toHaveBeenCalledWith({
      Bucket: "mvg",
      Key: "test-key",
    });
  });

  it("deleteFromR2 ignores 404/NoSuchKey errors (idempotent)", async () => {
    const error = new Error("Not Found");
    error.name = "NoSuchKey";
    mockSend.mockRejectedValueOnce(error);

    await expect(deleteFromR2("test-key")).resolves.not.toThrow();
  });

  it("deleteFromR2 rethrows unexpected errors", async () => {
    const error = new Error("Internal Server Error");
    mockSend.mockRejectedValueOnce(error);

    await expect(deleteFromR2("test-key")).rejects.toThrow("Internal Server Error");
  });

  // ---- Download ----

  it("downloadFromR2 reads the stream body into a Buffer", async () => {
    // Simulate a ReadableStream-like body that the SDK returns
    const chunks = [new Uint8Array([72, 101, 108]), new Uint8Array([108, 111])]; // "Hello"
    const mockBody = {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    };

    mockSend.mockResolvedValueOnce({ Body: mockBody });

    const result = await downloadFromR2("test-key");
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.toString()).toBe("Hello");
  });

  it("downloadFromR2 throws when body is empty", async () => {
    mockSend.mockResolvedValueOnce({ Body: null });

    await expect(downloadFromR2("missing-key")).rejects.toThrow("Empty response body");
  });

  // ---- Exists ----

  it("existsInR2 returns true when object exists", async () => {
    mockSend.mockResolvedValueOnce({});

    const exists = await existsInR2("test-key");
    expect(exists).toBe(true);
    expect(HeadObjectCommand).toHaveBeenCalledWith({
      Bucket: "mvg",
      Key: "test-key",
    });
  });

  it("existsInR2 returns false when object does not exist", async () => {
    mockSend.mockRejectedValueOnce(new Error("Not Found"));

    const exists = await existsInR2("test-key");
    expect(exists).toBe(false);
  });

  // ---- Metadata ----

  it("getR2Metadata returns metadata when object exists", async () => {
    mockSend.mockResolvedValueOnce({
      ContentType: "application/pdf",
      ContentLength: 1024,
    });

    const meta = await getR2Metadata("test-key");
    expect(meta).toEqual({ contentType: "application/pdf", contentLength: 1024 });
  });

  it("getR2Metadata returns null when object does not exist", async () => {
    mockSend.mockRejectedValueOnce(new Error("Not Found"));

    const meta = await getR2Metadata("test-key");
    expect(meta).toBeNull();
  });
});
