import type { LLMClient, StructuredRequest } from "@/lib/ai/client";

/** Scripted LLM: returns queued responses in order (string or Error) and records each request. */
export class FakeLLM implements LLMClient {
  readonly model = "fake-gemini-flash";
  calls: StructuredRequest[] = [];
  constructor(private responses: (string | Error | object)[]) {}
  async generateJson(req: StructuredRequest): Promise<string> {
    this.calls.push(req);
    const next = this.responses.shift();
    if (next === undefined) throw new Error("FakeLLM: no more scripted responses");
    if (next instanceof Error) throw next;
    return typeof next === "string" ? next : JSON.stringify(next);
  }
}
