import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_API_BASE,
  generateSessionKeypair,
} from "@stratabook/sdk";

const PUBLIC_KEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SECRET_KEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const PAIRING_TIMEOUT_MS = 10 * 60_000;

export const DEFAULT_PAIRING_WEB_BASE = "https://stratabook.app";

export interface StoredTradingConnection {
  readonly schema_version: 1;
  readonly owner_wallet: string;
  readonly session_public_key: string;
  readonly session_secret_key: string;
  readonly autonomy: "ask" | "limits" | "instant";
  readonly connected_at_ms: number;
}

export type PairingAction = "connect" | "disconnect";

export interface PairingOptions {
  readonly action: PairingAction;
  readonly webBase?: string;
  readonly openBrowser?: boolean;
  readonly credentialsFile?: string;
  readonly apiBase?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly nowMs?: () => number;
}

function validPublicKey(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_KEY_PATTERN.test(value);
}

function validSecretKey(value: unknown): value is string {
  return typeof value === "string" && SECRET_KEY_PATTERN.test(value);
}

export function tradingCredentialsPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform = process.platform,
  home = homedir(),
): string {
  const override = env.STRATA_MCP_CREDENTIALS_FILE?.trim();
  if (override) return resolve(override);
  if (platform === "win32") {
    const appData = env.APPDATA?.trim()
      || join(env.USERPROFILE?.trim() || home, "AppData", "Roaming");
    return join(appData, "Strata", "mcp.json");
  }
  const configRoot = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(configRoot, "strata", "mcp.json");
}

export async function readTradingConnection(
  path = tradingCredentialsPath(),
): Promise<StoredTradingConnection | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Strata trading credentials are not valid JSON: ${path}`);
  }
  if (!value || typeof value !== "object") {
    throw new Error(`Strata trading credentials are invalid: ${path}`);
  }
  const candidate = value as Partial<StoredTradingConnection>;
  if (
    candidate.schema_version !== 1
    || !validPublicKey(candidate.owner_wallet)
    || !validPublicKey(candidate.session_public_key)
    || !validSecretKey(candidate.session_secret_key)
    || !["ask", "limits", "instant"].includes(candidate.autonomy ?? "")
    || !Number.isSafeInteger(candidate.connected_at_ms)
  ) {
    throw new Error(`Strata trading credentials are invalid: ${path}`);
  }
  return candidate as StoredTradingConnection;
}

export async function writeTradingConnection(
  connection: StoredTradingConnection,
  path = tradingCredentialsPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(connection, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  // `mode` is honored on creation. chmod also tightens a pre-existing file.
  if (process.platform !== "win32") await chmod(path, 0o600);
}

export async function removeTradingConnection(
  path = tradingCredentialsPath(),
): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Explicit environment variables win; otherwise load the private local file. */
export async function loadTradingEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Record<string, string | undefined>> {
  if (env.STRATA_SESSION_SECRET_KEY || env.STRATA_OWNER_WALLET) return { ...env };
  const path = tradingCredentialsPath(env);
  const connection = await readTradingConnection(path);
  if (!connection) return { ...env };
  return {
    ...env,
    STRATA_OWNER_WALLET: connection.owner_wallet,
    STRATA_SESSION_PUBLIC_KEY: connection.session_public_key,
    STRATA_SESSION_SECRET_KEY: connection.session_secret_key,
    STRATA_AUTONOMY: env.STRATA_AUTONOMY ?? connection.autonomy,
  };
}

function pairingWebBase(raw: string): string {
  const url = new URL(raw);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("pairing web base must use HTTPS (or HTTP on localhost)");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function launchBrowser(url: string): void {
  const command = process.platform === "darwin"
    ? { file: "open", args: [url] }
    : process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

export function pairingPageUrl(
  webBase: string,
  action: PairingAction,
  sessionPublicKey: string,
  callbackUrl: string,
  existing: Pick<StoredTradingConnection, "owner_wallet" | "session_public_key"> | null,
): string {
  const agentUrl = new URL("/agents", pairingWebBase(webBase));
  agentUrl.searchParams.set("pair", action);
  agentUrl.searchParams.set("session_public_key", sessionPublicKey);
  if (existing) agentUrl.searchParams.set("owner_wallet", existing.owner_wallet);
  if (action === "connect" && existing) {
    agentUrl.searchParams.set("replace_session_public_key", existing.session_public_key);
  }
  agentUrl.searchParams.set("callback", callbackUrl);
  return agentUrl.toString();
}

async function waitForOnChainSession(
  apiBase: string,
  action: PairingAction,
  ownerWallet: string,
  sessionPublicKey: string,
  replaceSessionPublicKey: string | null,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastState = "unavailable";
  const stateFor = async (key: string): Promise<string | null> => {
    const query = new URLSearchParams({
      wallet_address: ownerWallet,
      session_public_key: key,
    });
    const response = await fetch(
      `${apiBase.replace(/\/$/, "")}/v2/vault/status?${query.toString()}`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) {
      lastState = `http_${response.status}`;
      return null;
    }
    const body = await response.json() as {
      wallet_address?: unknown;
      session?: { session_public_key?: unknown; state?: unknown } | null;
    };
    if (body.wallet_address !== ownerWallet) return null;
    if (!body.session) return "absent";
    if (body.session.session_public_key !== key || typeof body.session.state !== "string") return null;
    return body.session.state;
  };
  while (Date.now() < deadline) {
    try {
      const state = await stateFor(sessionPublicKey);
      lastState = state ?? lastState;
      if (action === "disconnect" && state === "absent") return;
      if (action === "connect" && state === "active") {
        if (!replaceSessionPublicKey || await stateFor(replaceSessionPublicKey) === "absent") return;
        lastState = "old_session_still_active";
      }
    } catch (error) {
      lastState = error instanceof Error ? error.name : "unavailable";
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error(
    `Strata could not confirm the ${action === "connect" ? "active" : "revoked"} session on-chain `
    + `(last state: ${lastState}). The local credential was not changed.`,
  );
}

async function waitForPairingCallback(
  sessionPublicKey: string,
  state: string,
  returnUrl: string,
  onComplete: (ownerWallet: string) => Promise<void>,
): Promise<{ callbackUrl: string; completion: Promise<string> }> {
  let settle!: (ownerWallet: string) => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<string>((resolvePromise, rejectPromise) => {
    settle = resolvePromise;
    reject = rejectPromise;
  });
  let finished = false;
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || requestUrl.pathname !== `/complete/${state}`) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Not found");
      return;
    }
    if (finished) {
      response.writeHead(409, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Pairing already completed");
      return;
    }
    const ownerWallet = requestUrl.searchParams.get("owner_wallet") ?? "";
    const returnedSession = requestUrl.searchParams.get("session_public_key") ?? "";
    if (!validPublicKey(ownerWallet) || returnedSession !== sessionPublicKey) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Invalid Strata pairing callback");
      return;
    }
    finished = true;
    try {
      await onComplete(ownerWallet);
      response.writeHead(303, {
        location: returnUrl,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      });
      response.end();
      settle(ownerWallet);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Could not save the local Strata connection");
      reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      server.close();
    }
  });
  server.on("error", (error) => reject(error));
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not start the local Strata pairing callback");
  }
  const timeout = setTimeout(() => {
    if (finished) return;
    finished = true;
    server.close();
    reject(new Error("Strata pairing timed out after 10 minutes"));
  }, PAIRING_TIMEOUT_MS);
  timeout.unref();
  completion.finally(() => clearTimeout(timeout)).catch(() => undefined);
  return {
    callbackUrl: `http://127.0.0.1:${address.port}/complete/${state}`,
    completion,
  };
}

export async function runLocalPairing(options: PairingOptions): Promise<void> {
  const env = options.env ?? process.env;
  const path = options.credentialsFile ?? tradingCredentialsPath(env);
  const existing = await readTradingConnection(path);
  if (options.action === "disconnect" && !existing) {
    process.stdout.write("Strata trading is not connected. Read-only tools remain ready.\n");
    return;
  }
  let generated: StoredTradingConnection;
  if (options.action === "disconnect" && existing) {
    generated = existing;
  } else {
    const keypair = await generateSessionKeypair();
    generated = {
      schema_version: 1,
      owner_wallet: "",
      session_public_key: keypair.publicKey,
      session_secret_key: keypair.secretKey,
      autonomy: "instant",
      connected_at_ms: 0,
    };
  }
  const state = randomBytes(24).toString("hex");
  const webBase = pairingWebBase(options.webBase ?? DEFAULT_PAIRING_WEB_BASE);
  const returnUrl = new URL("/agents", webBase);
  returnUrl.searchParams.set("paired", options.action === "connect" ? "connected" : "revoked");
  const replaceSessionPublicKey = options.action === "connect"
    ? existing?.session_public_key ?? null
    : null;
  const callback = await waitForPairingCallback(
    generated.session_public_key,
    state,
    returnUrl.toString(),
    async (ownerWallet) => {
      await waitForOnChainSession(
        options.apiBase ?? DEFAULT_API_BASE,
        options.action,
        ownerWallet,
        generated.session_public_key,
        replaceSessionPublicKey,
      );
      if (options.action === "disconnect") {
        if (existing?.owner_wallet !== ownerWallet) {
          throw new Error("the revoking wallet does not own this local Strata connection");
        }
        await removeTradingConnection(path);
        return;
      }
      await writeTradingConnection({
        ...generated,
        owner_wallet: ownerWallet,
        connected_at_ms: (options.nowMs ?? Date.now)(),
      }, path);
    },
  );
  const agentUrl = pairingPageUrl(
    webBase,
    options.action,
    generated.session_public_key,
    callback.callbackUrl,
    existing,
  );
  process.stdout.write(
    `${options.action === "disconnect" ? "Revoke" : replaceSessionPublicKey ? "Replace" : "Connect"} Strata agent access in your browser:\n${agentUrl}\n\n`,
  );
  if (options.openBrowser !== false) launchBrowser(agentUrl);
  process.stdout.write("Waiting for the owner-wallet signature…\n");
  const ownerWallet = await callback.completion;
  process.stdout.write(
    options.action === "connect"
      ? `✓ Trading connected for ${ownerWallet}. Credentials saved privately at ${path}.\nRestart or refresh your MCP client.\n`
      : `✓ Session revoked for ${ownerWallet}. Local trading credentials removed.\n`,
  );
}
