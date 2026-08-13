import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveAgentLaunch } from "../src/agent-profiles.ts";

async function configFile(value: unknown): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-detach-profiles-"));
	const path = join(directory, "profiles.json");
	await writeFile(path, JSON.stringify(value), "utf8");
	return path;
}

test("defaults bg_agent to Pi when no profile config exists", async () => {
	const launch = await resolveAgentLaunch({
		prompt: "Inspect the module.",
		label: "inspect-module",
		configPath: join(tmpdir(), `missing-${Date.now()}.json`),
	});
	assert.equal(launch.command, "pi");
	assert.equal(launch.runtime, "pi");
	assert.equal(launch.prompt, "Inspect the module.");
});

test("resolves a Pi role with per-launch model, tools, role skill, and anchor", async () => {
	const path = await configFile({
		defaultAgent: "pi",
		profiles: {
			scout: {
				skill: "advisor-role-scout",
				excludeTools: ["edit", "write", "bg_agent"],
				cliArgs: ["--advisor-worker-role", "scout"],
				maxTurns: 3,
				requireAnchor: true,
			},
		},
	});
	const launch = await resolveAgentLaunch({
		role: "scout",
		model: "openai-codex/gpt-5.6-sol",
		thinking: "high",
		prompt: "Find the source of the timeout.",
		anchor: "Write findings.md with direct source references.",
		requiredSkills: ["backend-development", "newrelic-logs"],
		label: "Scout timeout",
		configPath: path,
	});
	assert.equal(
		launch.command,
		"pi --provider openai-codex --model gpt-5.6-sol --thinking high --name scout-timeout --exclude-tools edit,write,bg_agent --advisor-worker-role scout",
	);
	assert.equal(launch.role, "scout");
	assert.equal(launch.model, "gpt-5.6-sol");
	assert.equal(launch.thinking, "high");
	assert.equal(launch.maxTurns, 3);
	assert.match(launch.prompt, /^\/skill:advisor-role-scout ROLE: scout/);
	assert.match(launch.prompt, /ANCHOR:\nWrite findings\.md/);
	assert.match(launch.prompt, /- backend-development\n- newrelic-logs/);
	assert.match(launch.prompt, /TURN CAP: 3$/);
});

test("role launches always require a model", async () => {
	const path = await configFile({ profiles: { scout: { skill: "advisor-role-scout" } } });
	await assert.rejects(
		resolveAgentLaunch({
			role: "scout",
			prompt: "Find the source of the timeout.",
			label: "scout",
			configPath: path,
		}),
		/needs a model chosen from the model map/,
	);
});

test("requires an anchor when the selected role profile requires one", async () => {
	const path = await configFile({ profiles: { checker: { requireAnchor: true } } });
	await assert.rejects(
		resolveAgentLaunch({
			role: "checker",
			model: "openai-codex/gpt-5.6-sol",
			prompt: "Review the change.",
			label: "checker",
			configPath: path,
		}),
		/requires a concrete anchor/,
	);
});

test("rejects unknown roles and reports the configured choices", async () => {
	const path = await configFile({ profiles: { scout: {}, builder: {} } });
	await assert.rejects(
		resolveAgentLaunch({
			role: "reviewer",
			prompt: "Review.",
			label: "reviewer",
			configPath: path,
		}),
		/Available roles: builder, scout/,
	);
});

test("keeps explicit non-Pi agent commands for compatibility", async () => {
	const launch = await resolveAgentLaunch({
		agent: "claude --model opus",
		prompt: "Review.",
		label: "legacy-review",
	});
	assert.equal(launch.command, "claude --model opus");
	assert.equal(launch.runtime, "claude");
});

test("does not allow an explicit agent and a configured role together", async () => {
	await assert.rejects(
		resolveAgentLaunch({
			agent: "codex",
			role: "builder",
			prompt: "Build.",
			label: "builder",
		}),
		/Choose either agent or role/,
	);
});

const MAPPED_CONFIG = {
	defaultAgent: "pi",
	models: {
		"openai-codex/gpt-5.6-sol": {
			character: "Workhorse.",
			thinking: ["high", "xhigh", "max"],
			defaultThinking: "high",
		},
		"openai-codex/gpt-5.6-luna": {
			character: "Cheap verifier.",
			thinking: ["max"],
			defaultThinking: "max",
		},
	},
	profiles: {
		builder: {
			skill: "advisor-role-builder",
			excludeTools: ["bg_agent"],
			cliArgs: ["--advisor-worker-role", "builder"],
			turnCapFlag: "--advisor-worker-max-turns",
			maxTurns: 6,
			requireAnchor: true,
		},
	},
} as const;

test("role launch picks model and thinking from the model map with turn-cap flag", async () => {
	const path = await configFile(MAPPED_CONFIG);
	const launch = await resolveAgentLaunch({
		role: "builder",
		model: "openai-codex/gpt-5.6-sol",
		thinking: "xhigh",
		prompt: "Implement the fix.",
		anchor: "Named checks pass in the worktree.",
		label: "Fix builder",
		configPath: path,
	});
	assert.equal(
		launch.command,
		"pi --provider openai-codex --model gpt-5.6-sol --thinking xhigh --name fix-builder --exclude-tools bg_agent --advisor-worker-role builder --advisor-worker-max-turns 6",
	);
	assert.equal(launch.thinking, "xhigh");
	assert.equal(launch.maxTurns, 6);
});

test("role launch applies the map's default thinking when none is requested", async () => {
	const path = await configFile(MAPPED_CONFIG);
	const launch = await resolveAgentLaunch({
		role: "builder",
		model: "openai-codex/gpt-5.6-luna",
		prompt: "Run the verification.",
		anchor: "Recording captured.",
		label: "verify",
		configPath: path,
	});
	assert.equal(launch.thinking, "max");
	assert.match(launch.command, /--model gpt-5\.6-luna --thinking max/);
});

test("rejects a role launch without a model when a model map exists", async () => {
	const path = await configFile(MAPPED_CONFIG);
	await assert.rejects(
		resolveAgentLaunch({
			role: "builder",
			prompt: "Implement.",
			anchor: "Checks pass.",
			label: "builder",
			configPath: path,
		}),
		/needs a model chosen from the model map[\s\S]*gpt-5\.6-sol[\s\S]*Workhorse/,
	);
});

test("rejects a model outside the model map", async () => {
	const path = await configFile(MAPPED_CONFIG);
	await assert.rejects(
		resolveAgentLaunch({
			role: "builder",
			model: "openai-codex/gpt-5.6-terra",
			prompt: "Implement.",
			anchor: "Checks pass.",
			label: "builder",
			configPath: path,
		}),
		/gpt-5\.6-terra is not in the model map/,
	);
});

test("rejects a thinking level the model map does not allow", async () => {
	const path = await configFile(MAPPED_CONFIG);
	await assert.rejects(
		resolveAgentLaunch({
			role: "builder",
			model: "openai-codex/gpt-5.6-luna",
			thinking: "high",
			prompt: "Verify.",
			anchor: "Recording captured.",
			label: "verify",
			configPath: path,
		}),
		/allows thinking max; requested high/,
	);
});

test("per-launch maxTurns overrides the profile turn cap", async () => {
	const path = await configFile(MAPPED_CONFIG);
	const launch = await resolveAgentLaunch({
		role: "builder",
		model: "openai-codex/gpt-5.6-sol",
		maxTurns: 9,
		prompt: "Implement the epic slice.",
		anchor: "Checks pass.",
		label: "big-builder",
		configPath: path,
	});
	assert.equal(launch.maxTurns, 9);
	assert.match(launch.command, /--advisor-worker-max-turns 9$/);
	assert.match(launch.prompt, /TURN CAP: 9$/);
});

test("plain Pi launch accepts a mapped model without a role", async () => {
	const path = await configFile(MAPPED_CONFIG);
	const launch = await resolveAgentLaunch({
		model: "openai-codex/gpt-5.6-luna",
		prompt: "Summarize the log file.",
		label: "log summary",
		configPath: path,
	});
	assert.equal(
		launch.command,
		"pi --provider openai-codex --model gpt-5.6-luna --thinking max --name log-summary",
	);
	assert.equal(launch.prompt, "Summarize the log file.");
});

test("does not allow model or thinking with an explicit agent command", async () => {
	await assert.rejects(
		resolveAgentLaunch({
			agent: "codex",
			model: "openai-codex/gpt-5.6-sol",
			prompt: "Build.",
			label: "builder",
		}),
		/not explicit agent commands/,
	);
});

test("role allowedModels restricts which mapped models the role may use", async () => {
	const path = await configFile({
		...MAPPED_CONFIG,
		profiles: {
			checker: {
				skill: "advisor-role-checker",
				allowedModels: ["openai-codex/gpt-5.6-luna"],
				maxTurns: 3,
			},
		},
	});
	await assert.rejects(
		resolveAgentLaunch({
			role: "checker",
			model: "openai-codex/gpt-5.6-sol",
			prompt: "Review.",
			label: "checker",
			configPath: path,
		}),
		/only allows models openai-codex\/gpt-5\.6-luna; requested openai-codex\/gpt-5\.6-sol/,
	);
	const launch = await resolveAgentLaunch({
		role: "checker",
		model: "openai-codex/gpt-5.6-luna",
		prompt: "Review.",
		label: "checker",
		configPath: path,
	});
	assert.match(launch.command, /--model gpt-5\.6-luna --thinking max/);
});
