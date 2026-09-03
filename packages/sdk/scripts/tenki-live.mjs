// Tenki live smoke test. Runs on Node against the built package because Bun's http2 client cannot
// stream command output from the Tenki data plane. Usage: bun run build && node scripts/tenki-live.mjs
import assert from "node:assert/strict";
import { createSandbox } from "../dist/index.mjs";
import { tenki } from "../dist/providers/tenki/index.mjs";

if (!process.env.TENKI_API_KEY && !process.env.TENKI_AUTH_TOKEN) {
  console.log("Skipping Tenki live test: TENKI_API_KEY is not set.");
  process.exit(0);
}

const startedAt = Date.now();
const step = (label) => console.log(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${label}`);
const deadline = setTimeout(() => {
  console.error("Tenki live test timed out");
  process.exit(1);
}, 420_000);

const sandbox = await createSandbox({
  provider: tenki({ name: "sandbox-sdk-live", idleTimeoutMinutes: 5 }),
  timeout: 180_000,
});
step(`created ${sandbox.id}`);
try {
  assert.equal((await sandbox.run("printf live-tenki")).stdout, "live-tenki");
  const failed = await sandbox.run("printf err >&2; exit 3");
  assert.deepEqual([failed.exitCode, failed.stderr, failed.success], [3, "err", false]);
  assert.equal(
    (await sandbox.run({ command: "printf", args: ["%s-%s", "a b", "c"] })).stdout,
    "a b-c",
  );
  assert.equal(
    (await sandbox.run("printf $LIVE_ENV", { env: { LIVE_ENV: "env-ok" } })).stdout,
    "env-ok",
  );
  await assert.rejects(sandbox.run("sleep 5", { timeout: 1_000 }), {
    code: "timeout",
    provider: "tenki",
  });
  step("commands ok");

  await sandbox.files.write("live.txt", "tenki-live-file");
  assert.equal(await sandbox.files.text("live.txt"), "tenki-live-file");
  assert.equal(
    (await sandbox.run("cat /workspace/live.txt && pwd")).stdout,
    "tenki-live-file/workspace\n",
  );
  await sandbox.files.mkdir("nested");
  await sandbox.files.write("nested/item.bin", new Uint8Array([0, 1, 2, 255]));
  assert.deepEqual([...(await sandbox.files.read("nested/item.bin"))], [0, 1, 2, 255]);
  assert.equal(await sandbox.files.exists("nested/item.bin"), true);
  assert.deepEqual(await sandbox.files.list("nested"), [
    { name: "item.bin", path: "/workspace/nested/item.bin", type: "file", size: 4 },
  ]);
  await sandbox.run("echo via-shell > nested/shell.txt");
  assert.equal(await sandbox.files.text("nested/shell.txt"), "via-shell\n");
  await sandbox.files.remove("nested");
  assert.equal(await sandbox.files.exists("nested"), false);
  await assert.rejects(sandbox.files.read("missing.txt"), { code: "not_found", provider: "tenki" });
  step("files ok");

  const cat = await sandbox.processes.start("cat");
  await cat.write("hello stdin\n");
  const iterator = cat.output()[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.data, "hello stdin\n");
  await cat.kill();
  assert.equal(await cat.status(), "killed");
  await cat.wait();
  const server = await sandbox.processes.start("python3 -m http.server 3111 --bind 0.0.0.0");
  const ready = await sandbox.run(
    "for i in $(seq 1 20); do curl -sf -o /dev/null http://127.0.0.1:3111/live.txt && exit 0; sleep 0.5; done; exit 1",
  );
  assert.equal(ready.success, true, "http.server did not start");
  step("processes ok");

  const preview = await sandbox.ports.expose(3111);
  assert.deepEqual([preview.public, preview.authenticated], [true, false]);
  const response = await fetch(new URL("/live.txt", preview.url));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "tenki-live-file");
  await server.kill();
  step("ports ok");

  const snapshot = await sandbox.snapshots.create({ name: "sandbox-sdk-live" });
  assert.equal(snapshot.mode, "memory");
  assert.equal((await sandbox.run("printf after-snapshot")).stdout, "after-snapshot");
  await sandbox.snapshots.delete(snapshot);
  step("snapshots ok");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await sandbox.stop();
  await sandbox.stop();
  step(`stopped (${sandbox.raw.state})`);
}
assert.ok(["TERMINATING", "TERMINATED"].includes(sandbox.raw.state), sandbox.raw.state);
clearTimeout(deadline);
process.exit(process.exitCode ?? 0);
