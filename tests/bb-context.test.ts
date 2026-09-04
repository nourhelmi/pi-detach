import assert from "node:assert/strict";
import { test } from "node:test";
import { detectBbContext } from "../src/bb/context.ts";
test("requires complete mutually-exclusive loopback BB context", () => {
  assert.deepEqual(detectBbContext({}), undefined);
  assert.throws(() => detectBbContext({ BB_THREAD_ID: "t" }), /partial/);
  assert.throws(() => detectBbContext({ BB_THREAD_ID: "t", BB_PROJECT_ID: "p", BB_ENVIRONMENT_ID: "e", BB_SERVER_URL: "https://example.com" }), /loopback/);
	assert.throws(() => detectBbContext({ BB_THREAD_ID: "t", BB_PROJECT_ID: "p", BB_ENVIRONMENT_ID: "e", BB_SERVER_URL: "http://127.0.0.1:3/not-an-origin" }), /loopback/);
  assert.throws(() => detectBbContext({ BB_THREAD_ID: "t", BB_PROJECT_ID: "p", BB_ENVIRONMENT_ID: "e", BB_SERVER_URL: "http://127.0.0.1:3", HERDR_ENV: "1" }), /mutually exclusive/);
  assert.equal(detectBbContext({ BB_THREAD_ID: "t", BB_PROJECT_ID: "p", BB_ENVIRONMENT_ID: "e", BB_SERVER_URL: "http://127.0.0.1:38886" })?.threadId, "t");
});
