import { describe, expect, it } from "vitest";
import { sanitize, trimMessages } from "../extensions/predictor.js";

// We need to construct AgentMessage-like objects; using `as any` at the boundary
// since the full AgentMessage shape is large and we only care about role/content/timestamp.
const asMessages = (m: unknown[]): Parameters<typeof trimMessages>[0] => m as never;

describe("trimMessages", () => {
	it("drops non-text content blocks on assistant messages", () => {
		const input = asMessages([
			{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "ok" },
					{ type: "toolCall", name: "bash", arguments: {} },
				],
				timestamp: 2,
			},
			{ role: "toolResult", content: [{ type: "text", text: "output" }], timestamp: 3 },
		]);
		const out = trimMessages(input, 6, 2000);
		expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(out[1]?.content).toEqual([{ type: "text", text: "ok" }]);
	});

	it("keeps the most recent messages up to the limit", () => {
		const input = asMessages(
			Array.from({ length: 10 }, (_, i) => ({
				role: i % 2 === 0 ? "user" : "assistant",
				content: [{ type: "text", text: `m${i}` }],
				timestamp: i,
			})),
		);
		const out = trimMessages(input, 4, 2000);
		expect(out.length).toBeLessThanOrEqual(4);
		expect(out[out.length - 1]?.role).toBe("assistant");
		expect(out.map((m) => (m.content as { text: string }[])[0]?.text)).toEqual([
			"m6",
			"m7",
			"m8",
			"m9",
		]);
	});

	it("strips trailing user messages so the sequence ends on assistant", () => {
		const input = asMessages([
			{ role: "assistant", content: [{ type: "text", text: "a" }], timestamp: 1 },
			{ role: "user", content: [{ type: "text", text: "b" }], timestamp: 2 },
		]);
		const out = trimMessages(input, 6, 2000);
		expect(out.length).toBe(1);
		expect(out[0]?.role).toBe("assistant");
	});

	it("skips messages with empty text content", () => {
		const input = asMessages([
			{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", name: "bash" }], timestamp: 2 },
			{ role: "assistant", content: [{ type: "text", text: "answered" }], timestamp: 3 },
		]);
		const out = trimMessages(input, 6, 2000);
		expect(out.length).toBe(2);
		expect(out[1]?.role).toBe("assistant");
		expect((out[1]?.content as { text: string }[])[0]?.text).toBe("answered");
	});

	it("caps per-message text length", () => {
		const input = asMessages([
			{ role: "assistant", content: [{ type: "text", text: "x".repeat(5000) }], timestamp: 1 },
		]);
		const out = trimMessages(input, 6, 100);
		expect((out[0]?.content as { text: string }[])[0]?.text.length).toBe(100);
	});
});

describe("sanitize", () => {
	it("strips leading/trailing quotes", () => {
		expect(sanitize('"run the tests"')).toBe("run the tests");
		expect(sanitize("'check ci status'")).toBe("check ci status");
		expect(sanitize("`commit changes`")).toBe("commit changes");
	});

	it("strips trailing punctuation", () => {
		expect(sanitize("run the tests.")).toBe("run the tests");
		expect(sanitize("done!!!")).toBe("done");
		expect(sanitize("why?")).toBe("why");
	});

	it("takes only the first line on multi-line output", () => {
		expect(sanitize("check CI status\nmore stuff")).toBe("check CI status");
	});

	it("caps to 10 whitespace-separated words", () => {
		expect(sanitize("one two three four five six seven eight nine ten eleven twelve")).toBe(
			"one two three four five six seven eight nine ten",
		);
	});

	it("returns empty string for whitespace-only input", () => {
		expect(sanitize("   \n  ")).toBe("");
	});

	it("handles nested quotes and punctuation combined", () => {
		expect(sanitize('  `"run the tests."` ')).toBe("run the tests");
	});

	it("strips ANSI escape sequences", () => {
		expect(sanitize("\x1b[31mrun the tests\x1b[0m")).toBe("run the tests");
		expect(sanitize("\x1b[2Jbye")).toBe("bye");
	});

	it("strips C0 and C1 control characters", () => {
		expect(sanitize("\x00\x07hello\x7fworld")).toBe("helloworld");
		expect(sanitize("\x9bcontrol bytes")).toBe("control bytes");
	});

	it("strips Unicode bidi and format overrides", () => {
		expect(sanitize("hello‮evil")).toBe("helloevil");
		expect(sanitize("﻿run tests")).toBe("run tests");
	});
});
