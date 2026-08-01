/**
 * @file sentinel.ts — completion detection for commands running in herdr panes.
 *
 * A pane is a shared terminal, not a child process, so exit is detected by
 * bracketing the command with printed markers and blocking on
 * `herdr wait output`. The exit marker's regex only matches once digits are
 * substituted for %d, so the shell's echo of the typed command can never
 * satisfy the wait early. Snapshots include scrollback from earlier runs in a
 * reused pane, which is why extraction slices from this run's start marker.
 */

const PREFIX = "<<pi-detach:";

export function startMarker(id: string): string {
	return `${PREFIX}${id}:start>>`;
}

export function exitMatchPattern(id: string): string {
	return `${PREFIX}${id}:[0-9]+>>`;
}

export function parseExitCode(id: string, matchedLine: string): number | undefined {
	const match = matchedLine.match(new RegExp(`${PREFIX}${id}:(\\d+)>>`));
	if (!match?.[1]) return undefined;
	return Number.parseInt(match[1], 10);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Wrap a command so its lifetime is observable in the pane transcript.
 * The body runs in a subshell: `exit`, `cd`, and exports cannot take down or
 * pollute the pane's interactive shell, and `$?` still propagates to the exit
 * marker. `cd` is prepended only when reusing a pane whose shell may sit in a
 * previous run's directory.
 */
export function wrapRunCommand(options: { id: string; command: string; cd?: string }): string {
	const { id, command, cd } = options;
	const start = `printf '${startMarker(id)}\\n'`;
	const body = cd ? `( cd ${shellQuote(cd)} && ${command} )` : `( ${command} )`;
	const exit = `printf '${PREFIX}${id}:%d>>\\n' $?`;
	return `${start}; ${body}; ${exit}`;
}

/**
 * Extract this run's output from a pane snapshot: everything after the last
 * standalone start marker, up to the exit marker, minus any line that carries
 * a sentinel for this run (including the shell's echo of the typed command).
 */
export function extractRunOutput(id: string, snapshot: string): string {
	const lines = snapshot.split("\n");
	const marker = startMarker(id);
	let begin = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i]?.trim() === marker) {
			begin = i + 1;
			break;
		}
	}
	const exitRe = new RegExp(`^${PREFIX}${id}:\\d+>>$`);
	const runPrefix = `${PREFIX}${id}:`;
	const out: string[] = [];
	for (let i = begin; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (exitRe.test(line.trim())) break;
		if (line.includes(runPrefix)) continue;
		out.push(line);
	}
	return out.join("\n").replace(/\n+$/, "");
}
