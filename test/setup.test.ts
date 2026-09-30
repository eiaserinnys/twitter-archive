import { readFile } from "node:fs/promises";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { buildWranglerConfig, parseAccountId, readInstanceConfig } from "../scripts/lib/setup/config.js";
import { syntheticArchiveFiles } from "./fixtures.js";

describe("instance setup", () => {
  const template = {
    name: "template", main: "src/worker/index.ts",
    assets: { directory: "./web", binding: "ASSETS" },
    triggers: { crons: ["*/30 * * * *"] },
    version_metadata: { binding: "CF_VERSION_METADATA" },
    vars: { SITE_TITLE: "default", X_USER_ID: "", KEEP: "kept" },
    routes: [{ pattern: "old.test", custom_domain: true }],
    d1_databases: [{ binding: "DB", database_name: "old", database_id: "old-id", migrations_dir: "migrations" }],
    r2_buckets: [{ binding: "MEDIA", bucket_name: "old" }],
  };
  it("overrides instance bindings and vars while preserving the template", () => {
    const config = buildWranglerConfig(template, { worker_name: "smoke", vars: { SITE_TITLE: "새 제목", EXTRA: "value" } }, "new-id");
    expect(config).toMatchObject({
      name: "smoke", vars: { SITE_TITLE: "새 제목", KEEP: "kept", EXTRA: "value" },
      d1_databases: [{ database_name: "smoke", database_id: "new-id", migrations_dir: "migrations" }],
      r2_buckets: [{ bucket_name: "smoke-media" }],
      workers_dev: true,
    });
    expect(config.routes).toBeUndefined();
    for (const key of ["assets", "triggers", "version_metadata", "main"]) expect(config[key]).toEqual(template[key as keyof typeof template]);
    expect(template.name).toBe("template");
  });
  it("uses a custom domain for the full hostname", () => {
    const config = buildWranglerConfig(template, { worker_name: "smoke", domain: { hostname: "archive.example.test", path: "" } }, "id");
    expect(config.routes).toEqual([{ pattern: "archive.example.test", custom_domain: true }]);
  });
  it("uses a zone route and sets BASE_PATH for a path instance", () => {
    const config = buildWranglerConfig(template, { worker_name: "smoke", d1_name: "db", r2_bucket: "media",
      domain: { hostname: "archive.example.test", path: "/twitter" }, vars: { BASE_PATH: "/wrong" } }, "id", "example.test");
    expect(config.routes).toEqual([{ pattern: "archive.example.test/twitter*", zone_name: "example.test" }]);
    expect(config.vars).toMatchObject({ BASE_PATH: "/twitter" });
    expect(config.d1_databases).toMatchObject([{ database_name: "db" }]);
    expect(config.r2_buckets).toMatchObject([{ bucket_name: "media" }]);
  });
  it("reads account.js as JSON without executing JavaScript", () => {
    expect(parseAccountId(syntheticArchiveFiles().get("data/account.js")!)).toBe("1");
    expect(() => parseAccountId(strToU8("window.YTD.account.part0 = [{account: malicious()}]"))).toThrow();
    expect(() => parseAccountId(strToU8('window.YTD.account.part0 = [{"account":{}}];'))).toThrow(/accountId/);
  });
  it("requires worker_name and prevents secret values entering the instance config", () => {
    expect(() => readInstanceConfig({})).toThrow(/worker_name/);
    expect(() => readInstanceConfig({ worker_name: "smoke", vars: { TYPESAFE_API_KEY: "secret" } })).toThrow(/environment/);
  });
  it("ignores instance files but keeps the template tracked", async () => {
    const ignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
    expect(ignore.split("\n")).toContain("instances/");
    expect(ignore.split("\n")).toContain("wrangler.*.toml");
    const templateToml = parse(await readFile(new URL("../wrangler.toml", import.meta.url), "utf8"));
    expect(templateToml.main).toBe("src/worker/index.ts");
  });
});
