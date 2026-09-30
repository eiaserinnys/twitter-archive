import type { InstanceConfig } from "./config.js";
import { SetupRuntime } from "./runtime.js";

export async function findZone(runtime: SetupRuntime, hostname: string): Promise<string> {
  const parts = hostname.split(".");
  for (let index = 0; index < parts.length - 1; index++) {
    const name = parts.slice(index).join(".");
    const zones = await runtime.api<Array<{ name: string }>>("/zones?name=" + encodeURIComponent(name));
    if (zones?.length) return zones[0].name;
  }
  throw new Error("No Cloudflare zone found for " + hostname);
}

export async function ensureResources(runtime: SetupRuntime, instance: InstanceConfig): Promise<string> {
  const databaseName = instance.d1_name ?? instance.worker_name;
  const bucketName = instance.r2_bucket ?? instance.worker_name + "-media";
  const databases = JSON.parse(await runtime.wrangler(["d1", "list", "--json"], { quiet: true })) as Array<{ name: string; uuid: string }>;
  let databaseId = databases.find((item) => item.name === databaseName)?.uuid;
  if (!databaseId) {
    await runtime.wrangler(["d1", "create", databaseName], { mutate: true });
    if (!runtime.dryRun) {
      const info = JSON.parse(await runtime.wrangler(["d1", "info", databaseName, "--json"], { quiet: true })) as { uuid: string };
      databaseId = info.uuid;
    }
  }
  const buckets = await runtime.wrangler(["r2", "bucket", "list"], { quiet: true });
  // Wrangler 4 prints labelled records for R2; it has no --json option.
  const names = [...buckets.matchAll(/^name:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  if (!names.includes(bucketName)) await runtime.wrangler(["r2", "bucket", "create", bucketName], { mutate: true });
  console.log("D1: " + (databaseId ? "existing/resolved" : "planned") + "; R2: " + (names.includes(bucketName) ? "existing" : "planned/created"));
  if (!databaseId && !runtime.dryRun) throw new Error("D1 did not return a database UUID.");
  return databaseId ?? "00000000-0000-0000-0000-000000000000";
}

interface AccessApp {
  id: string;
  aud: string;
  domain: string;
  policies?: Array<{ id: string }>;
}
interface AccessPolicy { id: string; name: string }

export async function configureAccess(
  runtime: SetupRuntime,
  instance: InstanceConfig,
  hostname: string,
  vars: Record<string, string>,
): Promise<void> {
  if (!instance.access) return;
  const root = "/accounts/" + runtime.env.CLOUDFLARE_ACCOUNT_ID;
  const organization = await runtime.api<{ auth_domain: string }>(root + "/access/organizations");
  if (!organization?.auth_domain) {
    console.log("Access skipped: create a Zero Trust organization in Cloudflare, then rerun setup.");
    return;
  }
  const domain = hostname + (instance.domain?.path ?? "") + "/owner";
  vars.ACCESS_TEAM_DOMAIN = organization.auth_domain;
  const apps = await runtime.api<AccessApp[]>(root + "/access/apps");
  let app = apps?.find((item) => item.domain === domain);
  if (runtime.dryRun) {
    if (!app) await runtime.api(root + "/access/apps", "POST", { name: instance.worker_name + " owner", type: "self_hosted", domain });
    console.log("Access plan: allow OWNER_EMAILS and attach " + instance.access.policy_ids.length + " reusable policies for " + domain);
    if (app) vars.ACCESS_AUD = app.aud;
    else vars.ACCESS_AUD = "<Access AUD after creation>";
    console.log("Plan: write ACCESS_AUD and ACCESS_TEAM_DOMAIN to generated Wrangler vars.");
    return;
  }
  if (!app) app = await runtime.api<AccessApp>(root + "/access/apps", "POST", {
    name: instance.worker_name + " owner", type: "self_hosted", domain,
  });
  if (!app) throw new Error("Cloudflare did not return an Access application.");
  const policyRoot = root + "/access/apps/" + app.id + "/policies";
  const policies = await runtime.api<AccessPolicy[]>(policyRoot);
  const policyName = instance.worker_name + " owner emails";
  const existingPolicy = policies?.find((item) => item.name === policyName);
  const emails = (vars.OWNER_EMAILS ?? "").split(",").map((email) => email.trim()).filter(Boolean);
  const emailPolicy = await runtime.api<AccessPolicy>(
    policyRoot + (existingPolicy ? "/" + existingPolicy.id : ""),
    existingPolicy ? "PUT" : "POST",
    { name: policyName, decision: "allow", include: emails.map((email) => ({ email: { email } })) },
  );
  if (!emailPolicy) throw new Error("Cloudflare did not return an owner email policy.");
  const policyIds = new Set([...(app.policies ?? []).map((policy) => policy.id), emailPolicy.id, ...instance.access.policy_ids]);
  await runtime.api(root + "/access/apps/" + app.id, "PUT", {
    name: instance.worker_name + " owner", type: "self_hosted", domain,
    policies: [...policyIds].map((id, index) => ({ id, precedence: index + 1 })),
  });
  vars.ACCESS_AUD = app.aud;
}
