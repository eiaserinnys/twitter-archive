import { afterEach, expect, it, vi } from "vitest";
import { SetupRuntime } from "../scripts/lib/setup/runtime.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("dry-run executes reads but cannot start mutation commands or API writes", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const fetchMock = vi.fn(async () => Response.json({ success: true, result: [] }));
  vi.stubGlobal("fetch", fetchMock);
  const runtime = new SetupRuntime(process.cwd(), true, {});
  expect(await runtime.command(["does-not-exist"], { mutate: true })).toBe("");
  expect(await runtime.api("/accounts/test/access/apps", "POST", { secret: "not-sent" })).toBeUndefined();
  expect(fetchMock).not.toHaveBeenCalled();
  await runtime.api("/zones?name=example.test");
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(await runtime.command([process.execPath, "-e", "process.stdout.write('read-ok')"], { quiet: true })).toBe("read-ok");
});

it("secret stdin is never returned or forwarded to output, including failed commands", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const runtime = new SetupRuntime(process.cwd(), false, {});
  const secret = "synthetic-secret-value";
  expect(await runtime.command([process.execPath, "-e", "process.stdin.pipe(process.stdout)"], { input: secret })).toBe("");
  await expect(runtime.command([process.execPath, "-e", "process.stdin.on('data', x => { process.stderr.write(x); process.exit(1); })"],
    { input: secret })).rejects.toThrow(/exit 1/);
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).not.toHaveBeenCalled();
});
