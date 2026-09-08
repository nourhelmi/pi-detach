import assert from "node:assert/strict";
import { test } from "node:test";
import { recoveryGuidance } from "../src/runtime-bridge.ts";

test("recovery guidance names the bound pane and agent and never suggests resend, adoption, or kill", () => {
    const text = recoveryGuidance({ reason: "effect-unproven" }, { id: JSON.stringify(["w1:p7", "builder-task-abc", "session", 3]) });
    assert.match(text, /could not prove the worker received its input/);
    assert.match(text, /Worker pane w1:p7 \(agent builder-task-abc\)/);
    assert.match(text, /will not resend, adopt, or kill/);
    assert.match(text, /launch a new worker/);
});

test("recovery guidance without a bound handle points at a possible empty pane", () => {
    for (const handle of [null, undefined, { id: "not-json" }, { id: JSON.stringify(["only-pane"]) }]) {
        const text = recoveryGuidance({ reason: "adapter-protocol-or-bound" }, handle);
        assert.match(text, /No worker pane was bound/);
        assert.match(text, /ambiguous/);
    }
});

test("recovery guidance keeps unknown reasons visible instead of inventing a cause", () => {
    assert.match(recoveryGuidance({ reason: "owner-restarted" }, null), /service restarted/);
    assert.match(recoveryGuidance({ reason: "something-new" }, null), /because of something-new/);
    assert.match(recoveryGuidance({}, null), /an unknown reason/);
});
