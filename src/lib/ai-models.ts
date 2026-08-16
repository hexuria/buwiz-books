// ============================================================================
// AI Model Registry — Single source of truth for model IDs and defaults
//
// This module defines the task categories, available models per category,
// and the default model for each task. All AI endpoints reference this
// registry instead of hardcoding model strings.
// ============================================================================

/** Task categories that each get their own model selection */
export type AITaskCategory = "ocr" | "textAnalysis" | "imageGen";

/** A selectable model with metadata for the settings UI */
export interface AIModelOption {
  id: string;
  name: string;
  description: string;
  recommended?: boolean;
}

/** Built-in default model for each task category */
export const AI_MODEL_DEFAULTS: Record<AITaskCategory, string> = {
  ocr: "gemini-3.1-flash-image-preview",
  textAnalysis: "gemini-3-flash-preview",
  imageGen: "gemini-3-pro-image-preview",
};

/** Available models per task category (drives the settings UI dropdowns) */
export const AI_MODEL_OPTIONS: Record<AITaskCategory, AIModelOption[]> = {
  ocr: [
    {
      id: "gemini-3.1-flash-image-preview",
      name: "Nano Banana 2",
      description: "Best for OCR — fast, multimodal with image understanding",
      recommended: true,
    },
    {
      id: "gemini-3-pro-image-preview",
      name: "Nano Banana Pro",
      description: "Highest quality image understanding, slower",
    },
    {
      id: "gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro",
      description: "Advanced reasoning for complex documents",
    },
    {
      id: "gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      description: "Stable, general purpose",
    },
  ],
  textAnalysis: [
    {
      id: "gemini-3-flash-preview",
      name: "Gemini 3 Flash",
      description: "Best balance of speed and reasoning",
      recommended: true,
    },
    {
      id: "gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro",
      description: "Maximum precision for complex analysis",
    },
    {
      id: "gemini-3.1-flash-lite-preview",
      name: "Gemini 3.1 Flash Lite",
      description: "Fastest and cheapest for simple tasks",
    },
    {
      id: "gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      description: "Stable, battle-tested",
    },
  ],
  imageGen: [
    {
      id: "gemini-3-pro-image-preview",
      name: "Nano Banana Pro",
      description: "Studio-quality image generation",
      recommended: true,
    },
    {
      id: "gemini-3.1-flash-image-preview",
      name: "Nano Banana 2",
      description: "Faster, lighter image generation",
    },
  ],
};

/** Org metadata key names for each task category */
export const AI_MODEL_META_KEYS: Record<AITaskCategory, string> = {
  ocr: "aiModelOcr",
  textAnalysis: "aiModelTextAnalysis",
  imageGen: "aiModelImageGen",
};

/** Task category labels for the settings UI */
export const AI_TASK_LABELS: Record<
  AITaskCategory,
  { title: string; description: string; icon: string }
> = {
  ocr: {
    title: "Document OCR Model",
    description: "Used for receipt, bill, and statement scanning",
    icon: "📄",
  },
  textAnalysis: {
    title: "Text Analysis Model",
    description: "Used for classification, transaction parsing, and matching",
    icon: "🧠",
  },
  imageGen: {
    title: "Image Generation Model",
    description: "Used for document thumbnail generation",
    icon: "🎨",
  },
};

/**
 * Resolve the model for a given task category.
 * Priority: explicit override → org per-task setting → built-in default
 */
export function resolveModelForTask(
  task: AITaskCategory,
  orgModels?: {
    aiModelOcr?: string;
    aiModelTextAnalysis?: string;
    aiModelImageGen?: string;
  },
): string {
  if (!orgModels) return AI_MODEL_DEFAULTS[task];

  switch (task) {
    case "ocr":
      return orgModels.aiModelOcr || AI_MODEL_DEFAULTS.ocr;
    case "textAnalysis":
      return orgModels.aiModelTextAnalysis || AI_MODEL_DEFAULTS.textAnalysis;
    case "imageGen":
      return orgModels.aiModelImageGen || AI_MODEL_DEFAULTS.imageGen;
    default:
      return AI_MODEL_DEFAULTS.textAnalysis;
  }
}
