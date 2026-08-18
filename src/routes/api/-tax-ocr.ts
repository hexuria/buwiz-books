/** Stage 3a OCR for a received 2307. Extraction only — capture stays a human review gate. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { aiComplete } from "../../lib/ai/facade";
import { GeminiRateLimitError } from "../../lib/gemini-client";
import { withMutationPermissionOrgContext } from "../../lib/server-context";
import { assertRolePermission } from "../../lib/auth-middleware";
import type { Form2307OcrOutput } from "../../lib/ai/schemas/form-2307-ocr";

const ocrSchema = z.object({
  base64Content: z.string().min(1),
  mimeType: z.string().min(1),
});

export const parseReceived2307Document = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "aiTask",
      "run",
      { routeKey: "tax:2307-ocr", limit: 10, windowMs: 300_000 },
      async ({ orgId, role }) => {
        assertRolePermission(role, "document", "view");
        const input = ocrSchema.parse(rawData);
        try {
          const result = await aiComplete<Form2307OcrOutput>({
            task: "form_2307_ocr",
            input: {},
            ctx: { orgId },
            media: [{ mimeType: input.mimeType, dataBase64: input.base64Content }],
          });
          if (!result.ok) {
            return { needsReview: true as const, validationIssues: result.issues, parsed: null };
          }
          return {
            needsReview: false as const,
            validationIssues: [] as string[],
            parsed: result.data,
          };
        } catch (err) {
          if (err instanceof GeminiRateLimitError) throw new Error(err.message);
          throw err;
        }
      },
    );
  },
);
