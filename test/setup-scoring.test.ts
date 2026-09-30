import { readFile, mkdir, writeFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { setup } from "../scripts/setup.js";
import { SetupRuntime } from "../scripts/lib/setup/runtime.js";

vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
  readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(),
}));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

const template = '[vars]\nX_USER_ID = ""\n[[d1_databases]]\nbinding = "DB"\n[[r2_buckets]]\nbinding = "MEDIA"\n';
const workerConfig = {
  worker_name: "smoke",
  vars: { X_USER_ID: "1" },
  domain: { hostname: "archive.example.test" },
  archive: "archive.zip",
};

function mockSetup(config: Record<string, unknown>) {
  const commands: string[][] = [];
  const wrangler = vi.spyOn(SetupRuntime.prototype, "wrangler").mockImplementation(async (args) => {
    if (args.join(" ") === "d1 list --json") return "[]";
    return "";
  });
  const command = vi.spyOn(SetupRuntime.prototype, "command").mockImplementation(async (args) => {
    commands.push(args);
    return "";
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(SetupRuntime.prototype, "api").mockImplementation(async () => {
    throw new Error("Unexpected Cloudflare API call.");
  });
  vi.mocked(readFile).mockImplementation(async (path) => String(path).endsWith("config.json")
    ? JSON.stringify(config)
    : template);
  return { commands, wrangler, command, warn };
}

function environment(target: "cloudflare" | "node", extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...(target === "cloudflare" ? { CLOUDFLARE_API_TOKEN: "synthetic-token", CLOUDFLARE_ACCOUNT_ID: "test" } : {}),
    ...extra,
  };
}

it("uses the default score budget of 2 for archive installs on both targets", async () => {
  for (const target of ["cloudflare", "node"] as const) {
    const config = { ...workerConfig, ...(target === "node" ? { target } : {}) };
    const harness = mockSetup(config);
    await setup(["--instance", "smoke", "--dry-run"], environment(target, {
      TYPESAFE_BASE_URL: "https://jev.test", TYPESAFE_API_KEY: "synthetic-key",
    }));
    const score = harness.commands.find((args) => args.includes("scripts/score.ts"));
    expect(score?.[score.indexOf("--max-usd") + 1]).toBe("2");
    expect(harness.warn).not.toHaveBeenCalled();
  }
});

it("errors when either Jev key is missing for archive installs on both targets", async () => {
  const cases = [
    { target: "cloudflare" as const, env: { TYPESAFE_API_KEY: "synthetic-key" } },
    { target: "node" as const, env: { TYPESAFE_BASE_URL: "https://jev.test" } },
  ];
  for (const { target, env } of cases) {
    const config = { ...workerConfig, ...(target === "node" ? { target } : {}) };
    const harness = mockSetup(config);
    await expect(setup(["--instance", "smoke", "--dry-run"], environment(target, env)))
      .rejects.toThrow("아카이브의 과거 트윗은 설치 중에만 채점됩니다. Jev 키를 넣거나 score_max_usd를 0으로 명시하세요.");
    expect(harness.commands).toHaveLength(0);
    expect(harness.wrangler).not.toHaveBeenCalled();
  }
});

it("warns once and skips archive scoring when score_max_usd is explicitly 0", async () => {
  const targets = ["cloudflare", "node"] as const;
  for (const target of targets) {
    const config = { ...workerConfig, target: target === "node" ? target : undefined, score_max_usd: 0 };
    const harness = mockSetup(config);
    harness.warn.mockClear();
    await setup(["--instance", "smoke", "--dry-run"], environment(target));
    expect(harness.warn).toHaveBeenCalledTimes(1);
    expect(harness.warn).toHaveBeenCalledWith("score_max_usd=0: 아카이브의 과거 트윗은 채점되지 않아 주제 연표에 나타나지 않습니다.");
    expect(harness.commands.some((args) => args.includes("scripts/score.ts"))).toBe(false);
  }
});
