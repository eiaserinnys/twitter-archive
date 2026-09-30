import { afterEach, expect, it, vi } from "vitest";
import { configureAccess } from "../scripts/lib/setup/cloudflare.js";
import { SetupRuntime } from "../scripts/lib/setup/runtime.js";

afterEach(() => vi.restoreAllMocks());

it("uses a configured Access team domain without organization permission", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const runtime = new SetupRuntime(process.cwd(), true, { CLOUDFLARE_ACCOUNT_ID: "test" });
  const api = vi.spyOn(runtime, "api").mockImplementation(async (path) => {
    if (path.endsWith("/access/organizations")) throw new Error("Forbidden organization lookup");
    return [{ id: "app", aud: "aud", domain: "archive.example.test/twitter/owner" }];
  });
  const vars = { ACCESS_TEAM_DOMAIN: "configured.cloudflareaccess.com", ACCESS_AUD: "" };
  await configureAccess(runtime, { worker_name: "test", domain: { hostname: "archive.example.test", path: "/twitter" },
    access: { policy_ids: ["reusable-policy"] } }, "archive.example.test", vars);
  expect(vars).toEqual({ ACCESS_TEAM_DOMAIN: "configured.cloudflareaccess.com", ACCESS_AUD: "aud" });
  expect(api.mock.calls.map(([path]) => path)).toEqual(["/accounts/test/access/apps"]);
});

it("queries the organization when the team domain is not configured", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const runtime = new SetupRuntime(process.cwd(), true, { CLOUDFLARE_ACCOUNT_ID: "test" });
  const api = vi.spyOn(runtime, "api").mockImplementation(async (path) => path.endsWith("/access/organizations")
    ? { auth_domain: "discovered.cloudflareaccess.com" }
    : [{ id: "app", aud: "aud", domain: "archive.example.test/owner" }]);
  const vars: Record<string, string> = {};
  await configureAccess(runtime, { worker_name: "test", access: { policy_ids: [] } }, "archive.example.test", vars);
  expect(vars.ACCESS_TEAM_DOMAIN).toBe("discovered.cloudflareaccess.com");
  expect(api.mock.calls.map(([path]) => path)).toEqual(["/accounts/test/access/organizations", "/accounts/test/access/apps"]);
});
