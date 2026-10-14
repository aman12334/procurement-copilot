import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The LLM SDKs must only ever run in server code (route handlers).
  serverExternalPackages: ["@google/genai", "@anthropic-ai/sdk", "sharp", "unpdf", "mammoth", "xlsx"],
  // Runtime reads the buyer's RFx files and vendor responses from disk; ship them with the functions on Vercel.
  outputFileTracingIncludes: {
    "/api/**": ["./stage1/buyer/**", "./stage1/vendors/**", "./stage1/images/**", "./data/event/**"],
  },
  // Offline-evaluation data must never be bundled into the runtime.
  outputFileTracingExcludes: {
    "*": ["./stage1/ground_truth/**", "./stage1/_build/**", "./eval/**"],
  },
};

export default nextConfig;
