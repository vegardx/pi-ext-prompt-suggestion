import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
// Base Editor renders an empty-buffer cursor as "\x1b[7m \x1b[0m" (one visible col).
// We replicate that when we rewrite the content line below.
const CURSOR_BLOCK = "\x1b[7m \x1b[0m";
const CURSOR_VISIBLE_WIDTH = 1;

export class GhostEditor extends CustomEditor {
	private ghost: string = "";

	setGhost(text: string): void {
		const next = text.trim();
		if (next === this.ghost) return;
		this.ghost = next;
		this.tui.requestRender();
	}

	clearGhost(): void {
		if (!this.ghost) return;
		this.ghost = "";
		this.tui.requestRender();
	}

	hasGhost(): boolean {
		return this.ghost.length > 0;
	}

	override handleInput(data: string): void {
		if (!this.ghost) {
			super.handleInput(data);
			return;
		}
		// Tab on empty buffer + ghost: populate the buffer and clear the ghost.
		// Do NOT forward to super — we consume Tab here. User presses Enter next to submit.
		if (matchesKey(data, "tab") && this.getText().length === 0) {
			const suggestion = this.ghost;
			this.ghost = "";
			this.setText(suggestion);
			this.tui.requestRender();
			return;
		}
		// Any other key clears the ghost and delegates normally.
		this.ghost = "";
		this.tui.requestRender();
		super.handleInput(data);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (!this.ghost) return lines;
		if (this.getText().length !== 0) return lines;
		// Base editor layout on empty buffer is [topBorder, contentLine, bottomBorder].
		// The content-line index is 1; any deviation (e.g. scroll indicator, future
		// layout change) is handled by bailing out below.
		if (lines.length < 3 || typeof lines[0] !== "string" || lines[0].length === 0) return lines;

		const paddingX = this.getPaddingX();
		const leftPad = " ".repeat(paddingX);
		const rightPad = leftPad;
		const innerWidth = Math.max(0, width - paddingX * 2 - CURSOR_VISIBLE_WIDTH);
		if (innerWidth === 0) return lines;

		const shown = truncateToWidth(this.ghost, innerWidth);
		const shownVisible = visibleWidth(shown);
		const fill = " ".repeat(Math.max(0, innerWidth - shownVisible));

		// IME hardware-cursor marker (emitted by base render) is intentionally
		// dropped while the ghost shows; any keypress clears the ghost and the
		// base render takes over again on the next frame.
		lines[1] = `${leftPad}${CURSOR_BLOCK}${DIM}${shown}${RESET}${fill}${rightPad}`;
		return lines;
	}
}
