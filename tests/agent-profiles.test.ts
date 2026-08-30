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
	assert.match(launch.prompt, /^Load and follow the role-reviewer skill before starting\.\n\nROLE: reviewer/);
	assert.match(launch.prompt, /ACCEPTANCE CRITERIA:\n[^\n]+\n1\. Report evidence-backed findings\./);
	assert.match(launch.prompt, /REQUIRED SKILLS:\nLoad and follow each listed skill before starting\.[\s\S]+- review-pr/);
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
		/requires at least one acceptance criterion/,
	);
});

test("acceptance criteria render numbered and satisfy a role's anchor requirement", async () => {
	const path = await configFile(GUARDED_PROFILE);
	const launch = await resolveAgentLaunch({
		role: "reviewer",
		prompt: "Review the change.",
		acceptance: ["Focused suites pass in the worktree.", "No new public API is introduced."],
		anchor: "Diff stays under 400 lines.",
		label: "reviewer",
		configPath: path,
	});
	assert.match(
		launch.prompt,
		/ACCEPTANCE CRITERIA:\n[^\n]+\n1\. Focused suites pass in the worktree\.\n2\. No new public API is introduced\.\n3\. Diff stays under 400 lines\./,
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

test("role thinking requires an explicit model", async () => {
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

test("plain Pi thinking requires an explicit model", async () => {
	await assert.rejects(
		resolveAgentLaunch({
			thinking: "high",
			prompt: "Review.",
			label: "thinking only",
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

test("builds every semantic role in native Codex or Claude from the selected model", async () => {
	const roles = ["scout", "planner", "reducer", "builder", "checker", "browser-verifier"];
	const path = await configFile({
		profiles: Object.fromEntries(
			roles.map((role) => [role, {
				agent: "pi",
				skill: `advisor-role-${role}`,
				skillPath: `skills/advisor-worker/roles/${role}/SKILL.md`,
			}]),
		),
	});
	for (const role of roles) {
		const launch = await resolveAgentLaunch({
			role,
			model: "openai-codex/gpt-5.6-luna",
			thinking: "max",
			harness: "native",
			prompt: "Complete the role task.",
			resultPath: `/tmp/native-${role}/result.md`,
			label: `codex ${role}`,
			configPath: path,
		});
		assert.equal(launch.runtime, "codex");
		assert.match(launch.prompt, new RegExp(`advisor-worker/roles/${role}/SKILL\\.md before starting`));
	}
	const codex = await resolveAgentLaunch({
		role: "scout",
		model: "openai-codex/gpt-5.6-luna",
		thinking: "max",
		harness: "native",
		prompt: "Inspect.",
		resultPath: "/tmp/native-scout/result.md",
		label: "codex scout",
		configPath: path,
	});
	assert.equal(
		codex.command,
		"codex --model gpt-5.6-luna -c model_reasoning_effort=max -c approval_policy=never --sandbox danger-full-access",
	);
	assert.doesNotMatch(codex.command, /--name|--provider/);
	assert.match(codex.prompt, /advisor-worker\/roles\/scout\/SKILL\.md before starting/);
	assert.match(codex.prompt, /Named skills are installed under .*\/skills/);
	assert.match(codex.prompt, /RESULT ARTIFACT:\nCreate the parent directory.*\/tmp\/native-scout\/result\.md/);
	assert.equal(codex.resultPath, "/tmp/native-scout/result.md");

	const claude = await resolveAgentLaunch({
		role: "checker",
		model: "claude-bridge/claude-sonnet-5",
		thinking: "high",
		harness: "native",
		prompt: "Check.",
		label: "claude checker",
		configPath: path,
	});
	assert.equal(
		claude.command,
		"claude --model claude-sonnet-5 --effort high --dangerously-skip-permissions",
	);
	assert.doesNotMatch(claude.command, /--name|--provider/);
});

test("native roles generate durable results under the advisor state root", async () => {
	const path = await configFile({ profiles: { reducer: { agent: "pi", skill: "advisor-role-reducer" } } });
	const previous = process.env.ADVISOR_STATE_ROOT;
	process.env.ADVISOR_STATE_ROOT = "/tmp/advisor-native-state";
	try {
		const launch = await resolveAgentLaunch({
			role: "reducer",
			harness: "native",
			model: "anthropic/claude-sonnet-5",
			prompt: "Reduce.",
			label: "reducer",
			configPath: path,
		});
		assert.match(launch.resultPath ?? "", /^\/tmp\/advisor-native-state\/runs\/native\/[0-9a-f-]+\/result\.md$/);
		assert.match(launch.prompt, new RegExp(`RESULT ARTIFACT:[\\s\\S]+${launch.resultPath?.replaceAll("/", "\\/")}`));
	} finally {
		if (previous === undefined) delete process.env.ADVISOR_STATE_ROOT;
		else process.env.ADVISOR_STATE_ROOT = previous;
	}
});

test("rejects native launches without a supported explicit model", async () => {
	const path = await configFile({ profiles: { scout: { agent: "pi", skill: "advisor-role-scout" } } });
	await assert.rejects(
		resolveAgentLaunch({ role: "scout", harness: "native", prompt: "Inspect.", label: "scout", configPath: path }),
		/requires an explicit model/,
	);
	await assert.rejects(
		resolveAgentLaunch({
			role: "scout",
			harness: "native",
			model: "cursor/grok-4.6",
			prompt: "Inspect.",
			label: "scout",
			configPath: path,
		}),
		/requires an OpenAI Codex or Anthropic model/,
	);
});

test("rejects Pi-only tool filtering on directly configured non-Pi roles", async () => {
	const path = await configFile({ profiles: { builder: { agent: "codex", excludeTools: ["bg_agent"] } } });
	await assert.rejects(
		resolveAgentLaunch({
			role: "builder",
			prompt: "Build.",
			label: "builder",
			configPath: path,
		}),
		/tools and excludeTools only configure Pi, not codex/,
	);
});

test("rejects Pi-only tool filtering when a semantic role selects native mode", async () => {
	const path = await configFile({ profiles: { builder: { agent: "pi", excludeTools: ["bg_agent"] } } });
	await assert.rejects(
		resolveAgentLaunch({
			role: "builder",
			harness: "native",
			model: "openai-codex/gpt-5.6-luna",
			prompt: "Build.",
			label: "builder",
			configPath: path,
		}),
		/Pi-only tool filtering that cannot be applied to a native harness/,
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
			harness: "native",
			prompt: "Build.",
			label: "builder",
		}),
		/harness cannot be combined/,
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
