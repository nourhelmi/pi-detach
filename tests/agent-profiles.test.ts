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

const GUARDED_PROFILE = {
	defaultAgent: "pi",
	profiles: {
		reviewer: {
			skill: "role-reviewer",
			tools: ["read", "bash"],
			excludeTools: ["edit", "bg_agent"],
			cliArgs: ["--worker-role", "reviewer"],
			turnCapFlag: "--worker-max-turns",
			maxTurns: 4,
			requireAnchor: true,
		},
	},
} as const;

const LEGACY_POLICY_CONFIG = {
	...GUARDED_PROFILE,
	models: {
		"openai-codex/mapped-model": {
			character: "Former recommendation metadata.",
			thinking: ["max"],
			defaultThinking: "max",
		},
	},
	profiles: {
		reviewer: {
			...GUARDED_PROFILE.profiles.reviewer,
			allowedModels: ["openai-codex/allowed-model"],
			allowedThinkingByModel: {
				"openai-codex/allowed-model": ["low"],
			},
		},
	},
} as const;

test("defaults bg_agent to plain Pi when no profile config exists", async () => {
	const launch = await resolveAgentLaunch({
		prompt: "Inspect the module.",
		label: "inspect-module",
		configPath: join(tmpdir(), `missing-${Date.now()}.json`),
	});
	assert.equal(launch.command, "pi");
	assert.equal(launch.runtime, "pi");
	assert.equal(launch.prompt, "Inspect the module.");
});

test("role launch needs no model and preserves skill, tool, anchor, and turn guardrails", async () => {
	const path = await configFile(GUARDED_PROFILE);
	const launch = await resolveAgentLaunch({
		role: "reviewer",
		prompt: "Review the transport change.",
		anchor: "Report evidence-backed findings.",
		requiredSkills: ["review-pr"],
		label: "Review transport",
		configPath: path,
	});
	assert.equal(
		launch.command,
		"pi --name review-transport --tools read,bash --exclude-tools edit,bg_agent --worker-role reviewer --worker-max-turns 4",
	);
	assert.equal(launch.role, "reviewer");
	assert.equal(launch.model, undefined);
	assert.equal(launch.thinking, undefined);
	assert.equal(launch.maxTurns, 4);
	assert.match(launch.prompt, /^\/skill:role-reviewer ROLE: reviewer/);
	assert.match(launch.prompt, /ANCHOR:\nReport evidence-backed findings\./);
	assert.match(launch.prompt, /REQUIRED SKILLS:\n- review-pr/);
	assert.match(launch.prompt, /TURN CAP: 4$/);
});

test("requires an anchor when the selected role profile requires one", async () => {
	const path = await configFile(GUARDED_PROFILE);
	await assert.rejects(
		resolveAgentLaunch({
			role: "reviewer",
			prompt: "Review the change.",
			label: "reviewer",
			configPath: path,
		}),
		/requires a concrete anchor/,
	);
});

test("old intelligence policy fields still parse but do not supply an identity", async () => {
	const path = await configFile(LEGACY_POLICY_CONFIG);
	const launch = await resolveAgentLaunch({
		role: "reviewer",
		prompt: "Review.",
		anchor: "Report findings.",
		label: "legacy config",
		configPath: path,
	});
	assert.doesNotMatch(launch.command, /--provider|--model|--thinking/);
	assert.equal(launch.model, undefined);
	assert.equal(launch.thinking, undefined);
});

test("accepts a supplied model outside the deprecated model map", async () => {
	const path = await configFile(LEGACY_POLICY_CONFIG);
	const launch = await resolveAgentLaunch({
		role: "reviewer",
		model: "anthropic/unmapped-model",
		prompt: "Review.",
		anchor: "Report findings.",
		label: "unmapped model",
		configPath: path,
	});
	assert.match(launch.command, /^pi --provider anthropic --model unmapped-model /);
	assert.equal(launch.provider, "anthropic");
	assert.equal(launch.model, "unmapped-model");
});

test("accepts a supplied model outside the deprecated role allowlist", async () => {
	const path = await configFile(LEGACY_POLICY_CONFIG);
	const launch = await resolveAgentLaunch({
		role: "reviewer",
		model: "openai-codex/mapped-model",
		prompt: "Review.",
		anchor: "Report findings.",
		label: "outside allowlist",
		configPath: path,
	});
	assert.match(launch.command, /--provider openai-codex --model mapped-model/);
});

test("forwards reasoning without enforcing deprecated recommendations", async () => {
	const path = await configFile(LEGACY_POLICY_CONFIG);
	const launch = await resolveAgentLaunch({
		role: "reviewer",
		model: "openai-codex/allowed-model",
		thinking: "high",
		prompt: "Review.",
		anchor: "Report findings.",
		label: "forward reasoning",
		configPath: path,
	});
	assert.match(launch.command, /--model allowed-model --thinking high/);
	assert.equal(launch.thinking, "high");
});

test("per-launch maxTurns overrides the profile turn cap", async () => {
	const path = await configFile(GUARDED_PROFILE);
	const launch = await resolveAgentLaunch({
		role: "reviewer",
		maxTurns: 7,
		prompt: "Review the larger change.",
		anchor: "Report findings.",
		label: "long review",
		configPath: path,
	});
	assert.equal(launch.maxTurns, 7);
	assert.match(launch.command, /--worker-max-turns 7$/);
	assert.match(launch.prompt, /TURN CAP: 7$/);
});

test("plain Pi launch forwards a supplied model and reasoning", async () => {
	const path = await configFile(LEGACY_POLICY_CONFIG);
	const launch = await resolveAgentLaunch({
		model: "openai-codex/unmapped-model",
		thinking: "xhigh",
		prompt: "Summarize the log.",
		label: "log summary",
		configPath: path,
	});
	assert.equal(
		launch.command,
		"pi --provider openai-codex --model unmapped-model --thinking xhigh --name log-summary",
	);
	assert.equal(launch.prompt, "Summarize the log.");
});

test("thinking requires an explicit model", async () => {
	await assert.rejects(
		resolveAgentLaunch({
			role: "reviewer",
			thinking: "high",
			prompt: "Review.",
			anchor: "Report findings.",
			label: "reviewer",
			configPath: await configFile(GUARDED_PROFILE),
		}),
		/thinking requires a model/,
	);
});

test("rejects malformed or unsafe model arguments", async () => {
	await assert.rejects(
		resolveAgentLaunch({
			model: "missing-provider-separator",
			prompt: "Review.",
			label: "bad model",
		}),
		/must be "provider\/model-id"/,
	);
	await assert.rejects(
		resolveAgentLaunch({
			model: "provider/model;rm",
			prompt: "Review.",
			label: "unsafe model",
		}),
		/model contains characters that bg_agent cannot pass safely/,
	);
});

test("rejects unsafe configured CLI arguments", async () => {
	const path = await configFile({
		profiles: {
			builder: {
				cliArgs: ["--mode;rm"],
			},
		},
	});
	await assert.rejects(
		resolveAgentLaunch({
			role: "builder",
			prompt: "Build.",
			label: "builder",
			configPath: path,
		}),
		/cliArgs contains characters that bg_agent cannot pass safely/,
	);
});

test("rejects unknown roles and reports configured choices", async () => {
	const path = await configFile({ profiles: { reviewer: {}, builder: {} } });
	await assert.rejects(
		resolveAgentLaunch({
			role: "scout",
			prompt: "Inspect.",
			label: "scout",
			configPath: path,
		}),
		/Available roles: builder, reviewer/,
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

test("does not combine an explicit agent command with Pi launch options", async () => {
	await assert.rejects(
		resolveAgentLaunch({
			agent: "codex",
			role: "builder",
			prompt: "Build.",
			label: "builder",
		}),
		/Choose either agent or role/,
	);
	await assert.rejects(
		resolveAgentLaunch({
			agent: "codex",
			model: "openai-codex/model",
			prompt: "Build.",
			label: "builder",
		}),
		/not explicit agent commands/,
	);
});
