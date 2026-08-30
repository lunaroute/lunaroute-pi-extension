import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
  buildExchangeBody,
  buildPiAuthUrl,
  computePkceChallenge,
  generatePkceVerifier,
  generateState,
  parseCallbackQuery,
  resolveApiUrl,
  resolveFrontUrl,
  type ExchangeRequest,
  type ExchangeResponse,
} from "./lunaroute.js";

const LOGIN_TIMEOUT_MS = 3 * 60_000;
const FAR_FUTURE_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export type LoopbackServer = {
  port: number;
  waitForCallback(): Promise<{ code: string; state: string }>;
  close(): void;
};

/** Real loopback server on 127.0.0.1:0 listening for /callback?code=&state=. */
export async function startLoopbackServer(): Promise<LoopbackServer> {
  let resolveCb: (r: { code: string; state: string }) => void;
  const cbPromise = new Promise<{ code: string; state: string }>((r) => (resolveCb = r));
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const { code, state } = parseCallbackQuery(url.toString());
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html");
    res.end("<html><body><h2>LunaRoute authorized.</h2><p>You can close this tab and return to pi.</p></body></html>");
    resolveCb({ code, state });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { port, waitForCallback: () => cbPromise, close: () => server.close() };
}

/** Real exchange: POST {apiUrl}/v1/auth/exchange. */
export async function exchangeCode(
  apiUrl: string,
  req: ExchangeRequest,
  _signal?: AbortSignal,
): Promise<ExchangeResponse> {
  const res = await fetch(`${apiUrl}/v1/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: buildExchangeBody(req),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      const code = body?.error?.code;
      const message = body?.error?.message;
      if (code && message) detail = `${code}: ${message}`;
      else if (code) detail = code;
      else if (message) detail = message;
    } catch {
      /* ignore */
    }
    throw new Error(`exchange failed: ${detail}`);
  }
  return (await res.json()) as ExchangeResponse;
}

export type LoginDeps = {
  startLoopback?: () => Promise<LoopbackServer>;
  exchange?: (apiUrl: string, req: ExchangeRequest, signal?: AbortSignal) => Promise<ExchangeResponse>;
  state?: () => string;
  verifier?: () => string;
  timeoutMs?: number;
};

const defaultDeps: LoginDeps = {
  startLoopback: startLoopbackServer,
  exchange: exchangeCode,
  state: generateState,
  verifier: generatePkceVerifier,
};

export async function loginWithBrowser(
  callbacks: OAuthLoginCallbacks,
  env: NodeJS.ProcessEnv,
  deps: LoginDeps = defaultDeps,
): Promise<string> {
  const d = { ...defaultDeps, ...deps };
  const verifier = d.verifier!();
  const challenge = computePkceChallenge(verifier);
  const state = d.state!();

  const server = await d.startLoopback!();
  try {
    const url = buildPiAuthUrl(resolveFrontUrl(env), server.port, state, challenge);
    callbacks.onAuth({ url, instructions: "Complete login in your browser." });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out waiting for browser authorization")), d.timeoutMs ?? LOGIN_TIMEOUT_MS);
    });
    let cb: { code: string; state: string };
    try {
      try {
        cb = await Promise.race([server.waitForCallback(), timeout]);
      } catch (err) {
        if (!(err instanceof Error) || !err.message.includes("timed out")) throw err;
        // ponytail: paste fallback only fires after the loopback timeout — the
        // front page's curl hint is the fast headless path; prompting during the
        // wait competes with the loopback for same-host users. Headless users
        // eat the 3-min wait unless they ran the curl already.
        const pasted = (await callbacks.onPrompt({
          message: "Timed out waiting for the browser. If your browser is on a different machine, paste the callback URL shown there (http://127.0.0.1:.../callback?code=...):",
        })).trim();
        if (!pasted) throw new Error("Login cancelled");
        cb = parseCallbackQuery(pasted);
      }
      if (cb.state !== state) throw new Error("state mismatch");
      const result = await d.exchange!(resolveApiUrl(env), {
        code: cb.code,
        verifier,
        label: hostname(),
      });
      return result.full_key;
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    server.close();
  }
}

export async function loginWithPaste(callbacks: OAuthLoginCallbacks): Promise<string> {
  const key = (await callbacks.onPrompt({ message: "Paste your LunaRoute API key (lr_...)" })).trim();
  return key;
}

export async function lunarouteLogin(
  callbacks: OAuthLoginCallbacks,
  env: NodeJS.ProcessEnv,
  deps: LoginDeps = defaultDeps,
): Promise<OAuthCredentials> {
  const method = await callbacks.onSelect({
    message: "Log in to LunaRoute",
    options: [
      { id: "browser", label: "Log in with browser" },
      { id: "paste", label: "Paste an API key" },
    ],
  });
  if (!method) throw new Error("Login cancelled");

  let key: string;
  if (method === "browser") {
    key = await loginWithBrowser(callbacks, env, deps);
  } else if (method === "paste") {
    key = await loginWithPaste(callbacks);
  } else {
    throw new Error(`Unknown login method: ${method}`);
  }
  if (!key) throw new Error("No API key provided");
  return { access: key, refresh: "", expires: Date.now() + FAR_FUTURE_MS };
}

export const lunarouteOAuth = {
  name: "LunaRoute",
  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    return lunarouteLogin(callbacks, process.env);
  },
  async refreshToken(creds: OAuthCredentials, _signal: AbortSignal): Promise<OAuthCredentials> {
    return creds;
  },
  getApiKey(creds: OAuthCredentials): string {
    return creds.access;
  },
};
