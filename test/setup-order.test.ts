import { readFile, writeFile, mkdir } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { setup } from "../scripts/setup.js";
import { SetupRuntime } from "../scripts/lib/setup/runtime.js";

vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
  readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(),
}));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it("plans Access then deploy then secrets then health/meta without writing files", async () => {
  const events: string[] = [];
  const ownerPassword = "synthetic-owner-password";
  const log = vi.spyOn(console, "log").mockImplementation((message) => { events.push(String(message)); });
  vi.mocked(readFile).mockImplementation(async (path) => String(path).endsWith("config.json")
    ? JSON.stringify({ worker_name: "test", domain: { hostname: "archive.example.test", path: "/twitter" },
      vars: { X_USER_ID: "1", ACCESS_TEAM_DOMAIN: "configured.cloudflareaccess.com" }, access: { policy_ids: [] } })
    : '[vars]\nX_USER_ID = ""\n[[d1_databases]]\nbinding = "DB"\n[[r2_buckets]]\nbinding = "MEDIA"\n');
  const commands: string[][] = [];
  vi.spyOn(SetupRuntime.prototype, "wrangler").mockImplementation(async (args) => {
    commands.push(args);
    events.push(args.join(" "));
    if (args.join(" ") === "d1 list --json") return "[]";
    return "";
  });
  vi.spyOn(SetupRuntime.prototype, "api").mockImplementation(async (path) => {
    events.push(path);
    if (path.startsWith("/zones?")) return [{ name: "example.test" }];
    if (path.endsWith("/access/organizations")) return { auth_domain: "discovered.cloudflareaccess.com" };
    if (path.endsWith("/access/apps")) return [{ id: "app", aud: "aud", domain: "archive.example.test/twitter/owner" }];
    throw new Error("Unexpected API call: " + path);
  });
  await setup(["--instance", "test", "--dry-run"], {
    CLOUDFLARE_API_TOKEN: "synthetic-token", CLOUDFLARE_ACCOUNT_ID: "test", TYPESAFE_API_KEY: "synthetic-secret",
    OWNER_PASSWORD: ownerPassword,
  });
  const deploy = commands.findIndex(([command]) => command === "deploy");
  const secret = commands.findIndex(([command]) => command === "secret");
  expect(deploy).toBeGreaterThan(-1);
  expect(secret).toBeGreaterThan(deploy);
  expect(events.findIndex((event) => event.endsWith("/access/apps"))).toBeLessThan(events.findIndex((event) => event.startsWith("deploy ")));
  expect(events.findIndex((event) => event.includes("/api/health"))).toBeGreaterThan(events.findIndex((event) => event.startsWith("secret put ")));
  const messages = log.mock.calls.map(([message]) => String(message));
  expect(commands).toContainEqual(["secret", "put", "OWNER_PASSWORD", "--config", "wrangler.test.toml"]);
  expect(messages.join("\n")).not.toContain(ownerPassword);
  expect(messages.findIndex((message) => message.startsWith("Access plan:"))).toBeLessThan(messages.findIndex((message) => message.includes("/api/health")));
  expect(messages).toContain("Plan: GET https://archive.example.test/twitter/api/meta (print total_tweets)");
  expect(writeFile).not.toHaveBeenCalled();
  expect(mkdir).not.toHaveBeenCalled();
});
