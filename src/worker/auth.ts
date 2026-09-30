import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env.js";

export interface Viewer {
  owner: boolean;
  viewingAs: "owner" | "visitor";
}

type AuthEnv = Pick<Env,
  "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD" | "OWNER_EMAILS" | "OWNER_SERVICE_TOKEN_IDS"
> & Partial<Pick<Env, "OWNER_AUTH" | "OWNER_PASSWORD">> & { DEV_OWNER?: string };

let jwksDomain: string | undefined;
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
const OWNER_COOKIE = "ta_owner";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();

function getAccessToken(request: Request): string | undefined {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (assertion !== null) return assertion;
  const cookie = request.headers.get("Cookie");
  const authorization = cookie?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("CF_Authorization="));
  return authorization?.slice("CF_Authorization=".length);
}

function list(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function visitor(): Viewer {
  return { owner: false, viewingAs: "visitor" };
}

function ownerViewer(request: Request): Viewer {
  return {
    owner: true,
    viewingAs: new URL(request.url).searchParams.get("as") === "visitor" ? "visitor" : "owner",
  };
}

function usablePassword(password: string | undefined): password is string {
  return password !== undefined && Array.from(password).length >= 12;
}

function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:" || request.headers.get("X-Forwarded-Proto") === "https";
}

async function importPasswordKey(password: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(password), {
    name: "HMAC",
    hash: "SHA-256",
  }, false, usages);
}

function encodeBase64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): ArrayBuffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  } catch {
    return null;
  }
}

function cookieAttributes(request: Request, maxAge: number): string {
  return `Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${isSecureRequest(request) ? "; Secure" : ""}`;
}

export async function verifyOwnerPassword(candidate: string, configured: string | undefined): Promise<boolean> {
  if (!usablePassword(configured)) return false;
  const [candidateDigest, configuredDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(configured)),
  ]);
  const candidateBytes = new Uint8Array(candidateDigest);
  const configuredBytes = new Uint8Array(configuredDigest);
  let difference = 0;
  for (let index = 0; index < configuredBytes.length; index += 1) {
    difference |= candidateBytes[index] ^ configuredBytes[index];
  }
  return difference === 0;
}

export async function createOwnerSessionCookie(request: Request, password: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  const key = await importPasswordKey(password, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(String(expires)));
  return `${OWNER_COOKIE}=${expires}.${encodeBase64Url(new Uint8Array(signature))}; ${cookieAttributes(request, SESSION_MAX_AGE)}`;
}

export function clearOwnerSessionCookie(request: Request): string {
  return `${OWNER_COOKIE}=; ${cookieAttributes(request, 0)}`;
}

async function hasValidOwnerSession(request: Request, password: string): Promise<boolean> {
  const cookie = request.headers.get("Cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${OWNER_COOKIE}=`))?.slice(OWNER_COOKIE.length + 1);
  if (!cookie) return false;

  const [expiresText, signatureText, ...extra] = cookie.split(".");
  if (extra.length > 0 || !/^\d+$/.test(expiresText)) return false;
  const expires = Number(expiresText);
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000)) return false;

  const signature = decodeBase64Url(signatureText);
  if (!signature || signature.byteLength !== 32) return false;
  const key = await importPasswordKey(password, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(expiresText));
}

export async function getViewer(request: Request, env: AuthEnv): Promise<Viewer> {
  if (env.DEV_OWNER === "1") return ownerViewer(request);
  if (env.OWNER_AUTH === "password") {
    if (!usablePassword(env.OWNER_PASSWORD)) return visitor();
    return await hasValidOwnerSession(request, env.OWNER_PASSWORD) ? ownerViewer(request) : visitor();
  }
  const domain = env.ACCESS_TEAM_DOMAIN.trim();
  if (!domain) return visitor();

  const token = getAccessToken(request);
  if (!token) return visitor();

  try {
    if (!jwks || jwksDomain !== domain) {
      jwksDomain = domain;
      jwks = createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`));
    }
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ["RS256"],
      issuer: `https://${domain}`,
      audience: list(env.ACCESS_AUD),
    });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    const commonName = typeof payload.common_name === "string" ? payload.common_name : "";
    const owner = list(env.OWNER_EMAILS).map((entry) => entry.toLowerCase()).includes(email)
      || list(env.OWNER_SERVICE_TOKEN_IDS).includes(commonName);
    return owner ? ownerViewer(request) : visitor();
  } catch {
    return visitor();
  }
}
