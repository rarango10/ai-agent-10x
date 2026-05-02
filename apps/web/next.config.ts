/* v0.2.0 – Langfuse OTel tracing */
import type { NextConfig } from "next";

const extraAllowedDevOrigins =
  process.env.NEXT_ALLOWED_DEV_ORIGINS?.split(",")
    .map((h) => h.trim())
    .filter(Boolean) ?? [];

/** One-level subdomain wildcards for ngrok free hostnames (Next.js: *.example.com). */
const allowedDevOrigins = [
  "*.ngrok-free.app",
  "*.ngrok-free.dev",
  ...extraAllowedDevOrigins,
];

const nextConfig: NextConfig = {
  transpilePackages: ["@agents/agent", "@agents/db", "@agents/types"],
  serverExternalPackages: [
    "@langchain/core",
    "@langchain/langgraph",
    "@langchain/openai",
    "@langfuse/langchain",
    "@langfuse/core",
    "@langfuse/otel",
    "@opentelemetry/sdk-node",
  ],
  allowedDevOrigins,
};

export default nextConfig;
