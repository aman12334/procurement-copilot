/**
 * `npm run llm:models` – lists the chat models your OPENAI_API_KEY can use (no generation calls, no cost) and checks
 * whether OPENAI_MODEL is among them. Use it to pick and pin OPENAI_MODEL.
 */
import { existsSync } from "node:fs";
import OpenAI from "openai";
import { expect, it } from "vitest";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

it("lists OpenAI models available to this key", async () => {
  expect(process.env.OPENAI_API_KEY?.trim(), "OPENAI_API_KEY must be set in .env.local").toBeTruthy();
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 30_000 });
  const ids: string[] = [];
  for await (const m of client.models.list()) ids.push(m.id);
  const chat = ids.filter((id) => /^(gpt|o\d|chatgpt)/i.test(id) && !/audio|realtime|transcribe|tts|search|image|embedding/i.test(id)).sort();
  console.log(`\n${chat.length} chat-capable models for this key:\n- ${chat.join("\n- ")}`);
  const pinned = process.env.OPENAI_MODEL?.trim();
  console.log(pinned ? `\nOPENAI_MODEL=${pinned} → ${ids.includes(pinned) ? "AVAILABLE" : "NOT AVAILABLE to this key"}` : "\nOPENAI_MODEL is not set yet – choose one from the list above.");
  if (pinned) expect(ids, `OPENAI_MODEL ${pinned} is not available to this key`).toContain(pinned);
});
