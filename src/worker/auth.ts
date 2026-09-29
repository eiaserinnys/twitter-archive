import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env.js";

export interface Viewer {
  owner: boolean;
  viewingAs: "owner" | "visitor";
}

type AuthEnv = Pick<Env,
  "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD" | "OWNER_EMAILS" | "OWNER_SERVICE_TOKEN_IDS"
> & { DEV_OWNER?: string };

let jwksDomain: string | undefined;
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

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

export async function getViewer(request: Request, env: AuthEnv): Promise<Viewer> {
  if (env.DEV_OWNER === "1") return ownerViewer(request);
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
