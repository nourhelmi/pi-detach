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
import { createViewerManager } from "../src/herdr/viewer.ts";
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
const viewer = createViewerManager(cli, panes);
const registry = createRegistry({
	herdrDriver: createHerdrDriver({ cli, ctx, panes, env: { PI_DETACH_HERDR_TOAST: "0" } }),
	onPromoted: viewer.attach,
});

function step(name: string): void {
	console.log(`— ${name}`);
}

async function paneExists(id: string): Promise<boolean> {
	const info = await cli.exec(["pane", "process-info", "--pane", id]);
	return info.ok;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
	step("a fast bg_run touches no panes");
	const fast = await registry.start({
		kind: "run",
		command: "echo fast-and-quiet",
		cwd: process.cwd(),
		label: "fast run",
	});
	const fastDone = await fast.completion;
	assert.equal(fastDone.backend, "local");
	assert.equal(fastDone.paneId, undefined);
	assert.match(registry.tail(fastDone.id, 5), /fast-and-quiet/);

	step("a promoted run gets a live viewer pane that closes on success");
	const promoted = await registry.start({
		kind: "run",
		command: "echo live-visible; sleep 7",
		cwd: process.cwd(),
		label: "promoted ok",
	});
	registry.markPromoted(promoted.record.id);
	// Generous: pane shell startup can take a couple of seconds before tail runs.
	await sleep(4000);
	const viewerPane = promoted.record.paneId;
	assert.ok(viewerPane, "viewer pane attached after promotion");
	const live = await cli.exec([
		"pane", "read", viewerPane as string, "--source", "recent-unwrapped", "--lines", "50", "--format", "text",
	]);
	assert.match(live.stdout, /live-visible/, "viewer pane tails the log");
	await promoted.completion;
	await sleep(1500);
	assert.equal(promoted.record.paneId, undefined, "record no longer points at a pane");
	assert.equal(await paneExists(viewerPane as string), false, "viewer pane closed on success");

	step("a promoted run that fails keeps its viewer pane");
	const failing = await registry.start({
		kind: "run",
		command: "echo bad-news; sleep 2; exit 5",
		cwd: process.cwd(),
		label: "promoted fail",
	});
	registry.markPromoted(failing.record.id);
	const failDone = await failing.completion;
	assert.equal(failDone.exitCode, 5);
	await sleep(1200);
	assert.ok(failing.record.paneId, "failure pane kept");
	assert.equal(await paneExists(failing.record.paneId as string), true);

	step("a watch is pane-hosted and its death is detected");
	const watch = await registry.start({
		kind: "watch",
		command: "echo watch-alive; sleep 2; echo watch-died",
		cwd: process.cwd(),
		label: "integration watch",
	});
	assert.ok(watch.record.paneId, "watch runs in a pane from birth");
	const watchDone = await watch.completion;
	assert.equal(watchDone.status, "exited");
	assert.match(registry.tail(watchDone.id, 10), /watch-died/);

	step("stopping a watch sends ctrl+c and settles as killed");
	const longWatch = await registry.start({
		kind: "watch",
		command: "sleep 120",
		cwd: process.cwd(),
		label: "integration stop",
	});
	registry.stop(longWatch.record.id);
	const stopped = await longWatch.completion;
	assert.equal(stopped.status, "killed");

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
