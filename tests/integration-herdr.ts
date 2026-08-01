/**
 * @file integration-herdr.ts — end-to-end check against a real herdr server.
 *
 * Not part of `bun run test`. Requires an isolated named herdr session, e.g.:
 *
 *   herdr server --session pidetachtest &
 *   HERDR_INTEGRATION=1 \
 *   HERDR_SOCKET_PATH=~/.config/herdr/sessions/pidetachtest/herdr.sock \
 *   HERDR_PANE_ID=w1:p1 \
 *   node --import tsx tests/integration-herdr.ts
 *
 * The pane id must exist in that session (create a workspace first). Never
 * point this at the default session: it splits panes and types into them.
 */

import assert from "node:assert/strict";
import { createHerdrCli } from "../src/herdr/cli.ts";
import { createHerdrDriver } from "../src/herdr/driver.ts";
import { createPaneManager } from "../src/herdr/panes.ts";
import { createRegistry } from "../src/registry.ts";

if (process.env.HERDR_INTEGRATION !== "1") {
	console.log("skipped: set HERDR_INTEGRATION=1 (plus HERDR_SOCKET_PATH and HERDR_PANE_ID) to run");
	process.exit(0);
}

const paneId = process.env.HERDR_PANE_ID;
if (!paneId || !process.env.HERDR_SOCKET_PATH) {
	console.error("HERDR_PANE_ID and HERDR_SOCKET_PATH are required");
	process.exit(1);
}

const cli = createHerdrCli();
const ctx = { paneId };
const panes = createPaneManager(cli, ctx);
const registry = createRegistry(
	createHerdrDriver({ cli, ctx, panes, env: { PI_DETACH_HERDR_TOAST: "0" } }),
);

function step(name: string): void {
	console.log(`— ${name}`);
}

try {
	step("run completes with exit 0 and captured output");
	const okRun = await registry.start({
		kind: "run",
		command: "echo integration-ok; sleep 1; echo tail-line",
		cwd: process.cwd(),
		label: "integration ok",
	});
	assert.equal(okRun.record.backend, "herdr");
	assert.ok(okRun.record.paneId, "run is hosted in a pane");
	const okDone = await okRun.completion;
	assert.equal(okDone.exitCode, 0);
	assert.match(registry.tail(okDone.id, 20), /integration-ok/);
	assert.match(registry.tail(okDone.id, 20), /tail-line/);

	step("failing run reuses the pane and reports its exit code");
	const failRun = await registry.start({
		kind: "run",
		command: "echo about-to-fail; exit 7",
		cwd: process.cwd(),
		label: "integration fail",
	});
	assert.equal(failRun.record.paneId, okDone.paneId, "pane was recycled");
	const failDone = await failRun.completion;
	assert.equal(failDone.exitCode, 7);
	assert.match(registry.tail(failDone.id, 20), /about-to-fail/);

	step("a watch that dies on its own resolves as exited");
	const watch = await registry.start({
		kind: "watch",
		command: "sleep 2; echo watch-died",
		cwd: process.cwd(),
		label: "integration watch",
	});
	const watchDone = await watch.completion;
	assert.equal(watchDone.status, "exited");

	step("stop sends ctrl+c and settles as killed");
	const longRun = await registry.start({
		kind: "run",
		command: "sleep 120",
		cwd: process.cwd(),
		label: "integration stop",
	});
	registry.stop(longRun.record.id);
	const stopped = await longRun.completion;
	assert.equal(stopped.status, "killed");

	step("bg_output live read works while a run is going");
	const liveRun = await registry.start({
		kind: "run",
		command: "echo live-visible; sleep 4",
		cwd: process.cwd(),
		label: "integration live",
	});
	await new Promise((r) => setTimeout(r, 1500));
	const live = await registry.readLog(liveRun.record.id, { lines: 50 });
	assert.match(live, /live-visible/);
	await liveRun.completion;

	console.log("PASS: all integration steps succeeded");
	for (const pane of panes.created()) {
		await cli.exec(["pane", "close", pane]);
	}
	process.exit(0);
} catch (error) {
	console.error("FAIL:", error);
	for (const pane of panes.created()) {
		await cli.exec(["pane", "close", pane]);
	}
	process.exit(1);
}
