/** GET /api/health – tells the UI which AI provider/model is configured (never returns the key). */
import { NextResponse } from "next/server";
import { AIConfigError, getLLMSettings } from "@/lib/ai/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const st = getLLMSettings();
    return NextResponse.json({ configured: true, provider: st.primary.provider, model: st.primary.model, fallback: st.fallback ? `${st.fallback.provider}:${st.fallback.model}` : null, fallback_status: st.fallback_status });
  } catch (e) {
    if (e instanceof AIConfigError) return NextResponse.json({ configured: false, message: e.message });
    throw e;
  }
}
