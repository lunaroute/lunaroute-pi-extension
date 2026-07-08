import { describe, expect, test } from "vitest";
import {
  LUNAROUTE_ENV_VAR,
  LUNAROUTE_PROVIDER,
  buildLunarouteHeaders,
  generateSessionId,
  hasLunarouteAuth,
  hasLunarouteProvider,
  missingApiKeyWarning,
  missingProviderWarning,
} from "../src/lunaroute.js";

describe("lunaroute helpers", () => {
  test("constants target only the canonical lunaroute provider and env var", () => {
    expect(LUNAROUTE_PROVIDER).toBe("lunaroute");
    expect(LUNAROUTE_ENV_VAR).toBe("LUNAROUTE_API_KEY");
  });

  test("buildLunarouteHeaders returns only LunaRoute v1 headers", () => {
    const headers = buildLunarouteHeaders("0.80.3", "session-123");

    expect(headers).toEqual({
      "lunaroute-agent": "pi/0.80.3",
      "x-lunaroute-session": "session-123",
      "lunaroute-session-id": "session-123",
    });
    expect(headers).not.toHaveProperty("User-Agent");
    expect(headers).not.toHaveProperty("user-agent");
  });

  test("generateSessionId uses randomUUID when available", () => {
    const id = generateSessionId(() => "11111111-1111-4111-8111-111111111111");
    expect(id).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("generateSessionId falls back to a safe unique-looking string", () => {
    const id = generateSessionId(
      () => {
        throw new Error("randomUUID unavailable");
      },
      () => 1234567890,
      () => 0.5,
    );

    expect(id).toBe("lunaroute-pi-1234567890-i");
  });

  test("hasLunarouteProvider requires provider exactly named lunaroute", () => {
    expect(hasLunarouteProvider([])).toBe(false);
    expect(hasLunarouteProvider([{ provider: "lunaroute11111" }])).toBe(false);
    expect(hasLunarouteProvider([{ provider: "openai" }, { provider: "lunaroute" }])).toBe(true);
  });

  test("hasLunarouteAuth accepts env var or Pi provider auth status", () => {
    expect(hasLunarouteAuth({}, { configured: false })).toBe(false);
    expect(hasLunarouteAuth({ LUNAROUTE_API_KEY: "lr_test" }, { configured: false })).toBe(true);
    expect(hasLunarouteAuth({}, { configured: true })).toBe(true);
  });

  test("warning text explains missing provider without secrets", () => {
    expect(missingProviderWarning()).toContain("no provider named `lunaroute`");
    expect(missingProviderWarning()).not.toContain("lr_");
  });

  test("warning text explains auth setup without secrets", () => {
    const warning = missingApiKeyWarning();

    expect(warning).toContain("no API key was found");
    expect(warning).toContain("export LUNAROUTE_API_KEY=lr_...");
    expect(warning).toContain("\"apiKey\": \"$LUNAROUTE_API_KEY\"");
    expect(warning).toContain("Stored Pi credential");
    expect(warning).not.toContain("lr_test");
  });
});
