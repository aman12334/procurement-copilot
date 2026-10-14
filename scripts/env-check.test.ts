/**
 * `npm run env:check` – verifies the runtime configuration without calling any model:
 * key + model present, server config loads, nothing exposed via NEXT_PUBLIC_, .env.local git-ignored,
 * and (if a production build exists) the key does not appear in client bundles.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

function walk(d: string): string[] {
  return existsSync(d) ? readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; }) : [];
}

it("environment is configured for the server-side LLM providers", async () => {
  const lines: string[] = [];
  const env = process.env;
  const { getLLMSettings, describeAIConfig } = await import("@/lib/ai/model");
  const provider = (env.LLM_PRIMARY_PROVIDER ?? env.AI_PROVIDER ?? "gemini").toLowerCase();
  const keyVar = `${provider.toUpperCase()}_API_KEY`, modelVar = `${provider.toUpperCase()}_MODEL`;
  lines.push(`LLM_PRIMARY_PROVIDER: ${provider}`);
  expect(env[keyVar]?.trim(), `${keyVar} must be set in .env.local`).toBeTruthy();
  expect(env[modelVar]?.trim(), `${modelVar} must be set in .env.local (run npm run llm:models)`).toBeTruthy();
  lines.push(`${keyVar}: present (${env[keyVar]!.length} chars, not printed)`, `${modelVar}: ${env[modelVar]}`);
  const st = getLLMSettings(env);
  lines.push(`server config loads: ${JSON.stringify(describeAIConfig(st.primary))}`, `fallback: ${st.fallback_status}`, `max attempts per call: ${st.max_attempts}`);
  const secrets = [env.OPENAI_API_KEY, env.GEMINI_API_KEY, env.ANTHROPIC_API_KEY].filter((x): x is string => !!x && x.length > 10);

  const publicKeys = Object.keys(env).filter((k) => k.startsWith("NEXT_PUBLIC_") && /KEY|SECRET|TOKEN|GEMINI|ANTHROPIC/i.test(k));
  expect(publicKeys, "no secrets via NEXT_PUBLIC_").toEqual([]);
  const clientSrc = [...walk("components"), ...walk("app")].filter((f) => /\.(tsx?|jsx?)$/.test(f) && !f.includes(`${path.sep}api${path.sep}`));
  const leaking = clientSrc.filter((f) => /process\.env\.(OPENAI|GEMINI|ANTHROPIC|LLM_|FREE_|NEXT_PUBLIC_(OPENAI|GEMINI|ANTHROPIC))/.test(readFileSync(f, "utf8")));
  expect(leaking, "client code must not read model keys").toEqual([]);
  expect(readFileSync(".gitignore", "utf8")).toMatch(/^\.env\*\.local$/m);
  lines.push("no NEXT_PUBLIC_ secrets; client code does not read keys; .env.local is git-ignored");

  const bundle = walk(".next/static").filter((f) => f.endsWith(".js"));
  if (bundle.length) {
    const hit = bundle.filter((f) => { const t = readFileSync(f, "utf8"); return secrets.some((k) => t.includes(k)); });
    expect(hit, "API key found in client bundle").toEqual([]);
    lines.push(`client bundle scanned (${bundle.length} files): key not present`);
  } else lines.push("no production build found – bundle scan skipped (run npm run build first to include it)");
  console.log("\nENV CHECK OK\n- " + lines.join("\n- "));
});
