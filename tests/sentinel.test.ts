import assert from "node:assert/strict";
import { test } from "node:test";
import {
	exitMatchPattern,
	extractRunOutput,
	parseExitCode,
	startMarker,
	wrapRunCommand,
} from "../src/herdr/sentinel.ts";

test("wraps a command with start and exit markers in a subshell", () => {
	const wrapped = wrapRunCommand({ id: "ab12cd", command: "bun test" });
	assert.match(wrapped, /^printf '<<pi-detach:ab12cd:start>>\\n'; \( bun test \); printf/);
	assert.match(wrapped, /%d>>/);
});

test("prepends cd inside the subshell only when reusing a pane", () => {
	const wrapped = wrapRunCommand({ id: "ab12cd", command: "bun test", cd: "/tmp/it's here" });
	assert.match(wrapped, /\( cd '\/tmp\/it'\\''s here' && bun test \)/);
});

test("the exit pattern does not match the shell's echo of the command", () => {
	const wrapped = wrapRunCommand({ id: "ab12cd", command: "bun test" });
	assert.doesNotMatch(wrapped, new RegExp(exitMatchPattern("ab12cd")));
	assert.match("<<pi-detach:ab12cd:0>>", new RegExp(exitMatchPattern("ab12cd")));
});

test("parses the exit code from a matched line", () => {
	assert.equal(parseExitCode("ab12cd", "<<pi-detach:ab12cd:0>>"), 0);
	assert.equal(parseExitCode("ab12cd", "<<pi-detach:ab12cd:137>>"), 137);
	assert.equal(parseExitCode("ab12cd", "<<pi-detach:other0:1>>"), undefined);
});

test("extracts only this run's output from a reused pane snapshot", () => {
	const snapshot = [
		"old scrollback from a previous run",
		"<<pi-detach:old111:start>>",
		"previous output",
		"<<pi-detach:old111:0>>",
		"➜  repo printf '<<pi-detach:ab12cd:start>>\\n'; bun test; printf '<<pi-detach:ab12cd:%d>>\\n' $?",
		startMarker("ab12cd"),
		"test one passed",
		"test two passed",
		"<<pi-detach:ab12cd:0>>",
		"➜  repo",
	].join("\n");
	assert.equal(extractRunOutput("ab12cd", snapshot), "test one passed\ntest two passed");
});

test("extraction tolerates a missing exit marker (interrupted run)", () => {
	const snapshot = [
		startMarker("ab12cd"),
		"partial output",
		"^C",
		"➜  repo",
	].join("\n");
	assert.equal(extractRunOutput("ab12cd", snapshot), "partial output\n^C\n➜  repo");
});
