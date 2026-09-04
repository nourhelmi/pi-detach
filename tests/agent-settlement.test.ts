import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decideAgentSettlement, parseResultArtifactStatus, readSettlementArtifact, settlementArtifactIssue } from "../src/agent-settlement.ts";

const artifact = (status: string) => `## Status\n${status}\n## Claims\none\n## Evidence\ntwo\n## Files\nthree\n## Decisions\nfour\n## Remaining Risk\nfive\n`;
test("validates parser-visible six-heading artifacts", async () => { const dir = await mkdtemp(join(tmpdir(), "settlement-")); const path = join(dir, "result.md"); await writeFile(path, artifact("PASS")); assert.equal(await settlementArtifactIssue(path), undefined); await writeFile(path, artifact("PASS").replace("two", "")); assert.match(await settlementArtifactIssue(path) ?? "", /empty sections: Evidence/); });
test("fingerprints only the same artifact snapshot that passed all six headings", async () => {
	const dir = await mkdtemp(join(tmpdir(), "settlement-snapshot-"));
	const path = join(dir, "result.md");
	await writeFile(path, "## Status\nPASS\n");
	const invalid = await readSettlementArtifact(path);
	assert.match(invalid.issue ?? "", /missing headings/);
	assert.equal(invalid.status, undefined);
});
test("classifies status and settles only terminal artifacts without live descendants", () => {
  const blocked = parseResultArtifactStatus(artifact("BLOCKED — input")); assert.equal(blocked?.classification, "blocked");
  assert.deepEqual(parseResultArtifactStatus(artifact("Status: BLOCKED")), { line: "BLOCKED", classification: "blocked" });
  assert.equal(decideAgentSettlement({ transportState: "idle", artifact: { status: blocked }, logicalDescendants: "none" }).kind, "pause");
  const terminal = parseResultArtifactStatus(artifact("PASS"));
	assert.ok(terminal);
	assert.equal(decideAgentSettlement({ transportState: "idle", artifact: { status: terminal }, logicalDescendants: "live" }).kind, "wait");
	assert.equal(decideAgentSettlement({ transportState: "idle", artifact: { status: terminal }, logicalDescendants: "none" }).kind, "finish");
  assert.equal(decideAgentSettlement({ transportState: "idle", artifact: { issue: "stale" }, logicalDescendants: "none" }).kind, "finish");
});
test("settlement generations are stable per canonical artifact and distinct across sibling run paths", async () => {
	const dir = await mkdtemp(join(tmpdir(), "settlement-generation-"));
	const left = join(dir, "left", "result.md");
	const right = join(dir, "right", "result.md");
	await Promise.all([mkdir(join(dir, "left")), mkdir(join(dir, "right"))]);
	await Promise.all([writeFile(left, artifact("PASS")), writeFile(right, artifact("PASS"))]);
	const leftArtifact = await readSettlementArtifact(left);
	const rightArtifact = await readSettlementArtifact(right);
	const leftDecision = decideAgentSettlement({ transportState: "idle", artifact: leftArtifact, logicalDescendants: "none" });
	const repeated = decideAgentSettlement({ transportState: "idle", artifact: leftArtifact, logicalDescendants: "none" });
	const rightDecision = decideAgentSettlement({ transportState: "idle", artifact: rightArtifact, logicalDescendants: "none" });
	assert.equal(leftDecision.kind, "finish");
	assert.deepEqual(repeated, leftDecision);
	assert.notEqual(leftDecision.kind === "finish" ? leftDecision.generation : "", rightDecision.kind === "finish" ? rightDecision.generation : "");
});
