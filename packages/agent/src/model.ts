import { ChatOpenAI } from "@langchain/openai";

export function createChatModel() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  // OpenRouter deprecated `qwen/qwen3.6-plus:free`; use paid id or set OPENROUTER_MODEL.
  const modelName =
    process.env.OPENROUTER_MODEL?.trim() || "qwen/qwen3.6-plus";

  return new ChatOpenAI({
    modelName,
    temperature: 0.3,
    // OpenRouter free tiers often return 429; default LangChain retries (~7) can block the request for ~100s.
    maxRetries: 0,
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://agents.local",
      },
    },
    apiKey,
  });
}
