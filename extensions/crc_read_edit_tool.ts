/**
 * CRC Read/Edit Tool - Whole-file CRC variant.
 *
 * Instead of per-line tags, uses a single file-level CRC32 for CAS verification.
 * Edits specify only line ranges (startLine:endLine), making them more compact.
 *
 * Read output format:
 *   LINE CONTENT (with file CRC in header)
 *
 * Edit input:
 *   { path, crc: "XXXX", edits: [{ startLine: 10, endLine: 23, new: "..." }] }
 *
 * Tradeoff: fails on ANY file change (even unrelated), but much fewer tokens.
 *
 * Usage:
 *   pi -e ./crc_read_edit_tool.ts
 */

import type { TextContent } from "@earendil-works/pi-ai";
import { type EditToolDetails, type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile, writeFile } from "fs/promises";
import { resolve } from "path";
import { Type } from "typebox";
import { crc32 as nodeCrc32 } from "zlib";

// =============================================================================
// CRC
// =============================================================================

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function toBase62(num: number, length: number): string {
	let result = "";
	for (let i = 0; i < length; i++) {
		result = BASE62[num % 62] + result;
		num = Math.floor(num / 62);
	}
	return result;
}

/** 4-char CRC32 tag for an entire file's content */
function fileCrc(content: string): string {
	return toBase62(nodeCrc32(content) >>> 0, 4);
}

// =============================================================================
// Diff Generation (matching built-in edit tool output)
// =============================================================================

function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					for (const line of raw.slice(0, contextLines)) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					const skipped = raw.length - contextLines * 2;
					oldLineNum += skipped;
					newLineNum += skipped;
					for (const line of raw.slice(raw.length - contextLines)) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
				if (raw.length > contextLines) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += raw.length - contextLines;
					newLineNum += raw.length - contextLines;
				}
			} else if (hasTrailingChange) {
				const skipped = Math.max(0, raw.length - contextLines);
				if (skipped > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skipped;
					newLineNum += skipped;
				}
				for (const line of raw.slice(skipped)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

function generateUnifiedPatch(path: string, oldContent: string, newContent: string): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: 4,
	});
}

// =============================================================================
// Read Tool
// =============================================================================

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

// =============================================================================
// Edit Tool
// =============================================================================

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		crc: Type.String({ description: "4-char file CRC from the read tool output. Verifies the file has not changed since you read it." }),
		edits: Type.Array(
			Type.Object(
				{
					startLine: Type.Number({ description: "First line number to replace (1-indexed)" }),
					endLine: Type.Number({
						description: "Last line number to replace (inclusive, 1-indexed). Same as startLine for single-line edits.",
					}),
					new: Type.String({
						description: "Replacement text. Use empty string to delete lines.",
					}),
				},
				{ additionalProperties: false },
			),
			{
				description:
					"One or more line-range replacements. Each edit specifies a line range (startLine:endLine). Edits must not overlap and are applied in reverse order.",
			},
		),
	},
	{ additionalProperties: false },
);

interface EditEntry {
	startLine: number;
	endLine: number;
	new: string;
}

export default function crcReadEditExtension(pi: ExtensionAPI) {
	// Override read tool
	pi.registerTool({
		name: "read",
		label: "read",
		description:
			"Read the contents of a file. Each line is prefixed with its line number. The output includes a 4-char file CRC that must be passed to the edit tool to verify the file hasn't changed. Output is truncated to 2000 lines or 50KB. Use offset/limit for large files.",
		promptSnippet: "Read file contents with line numbers and a file CRC for editing",
		promptGuidelines: [
			"Use read to examine files. Output format: `LINE CONTENT` per line, with a 4-char file CRC at the end.",
			"Remember the file CRC — pass it to the edit tool to verify the file hasn't changed.",
			"Use edit with line numbers from the read tool output.",
		],
		parameters: readSchema,

		async execute(_toolCallId, params, signal) {
			const { path, offset, limit } = params;
			const absolutePath = resolve(process.cwd(), path);

			if (signal?.aborted) throw new Error("Operation aborted");

			try {
				await access(absolutePath, constants.R_OK);
			} catch (error: any) {
				const code = error.code || "UNKNOWN";
				throw new Error(`Could not read file: ${path}. Error code: ${code}.`);
			}

			if (signal?.aborted) throw new Error("Operation aborted");

			const fullContent = await readFile(absolutePath, "utf-8");
			const crc = fileCrc(fullContent);
			const allLines = fullContent.split("\n");
			const totalLines = allLines.length;

			// Apply offset (1-indexed)
			const startLine = offset ? Math.max(1, offset) : 1;
			const startIndex = startLine - 1;

			if (startIndex >= allLines.length) {
				throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
			}

			// Apply limit
			const endIndex = limit !== undefined ? Math.min(startIndex + limit, allLines.length) : allLines.length;
			const selectedLines = allLines.slice(startIndex, endIndex);
			let content = selectedLines.join("\n");

			// Truncation: 2000 lines or 50KB
			const MAX_LINES = 2000;
			const MAX_BYTES = 50 * 1024;
			let truncated = false;
			let shownLines = selectedLines.length;

			if (selectedLines.length > MAX_LINES) {
				content = selectedLines.slice(0, MAX_LINES).join("\n");
				shownLines = MAX_LINES;
				truncated = true;
			}

			if (Buffer.byteLength(content, "utf-8") > MAX_BYTES) {
				let bytes = 0;
				let i = 0;
				for (; i < selectedLines.length; i++) {
					const lineBytes = Buffer.byteLength(selectedLines[i] + "\n", "utf-8");
					if (bytes + lineBytes > MAX_BYTES) break;
					bytes += lineBytes;
				}
				content = selectedLines.slice(0, i).join("\n");
				shownLines = i;
				truncated = true;
			}

			// Format with line numbers
			const lines = content.split("\n");
			const maxLineNum = startLine + lines.length - 1;
			const lineNumWidth = String(maxLineNum).length;
			const formatted = lines
				.map((line, i) => {
					const lineNum = String(startLine + i).padStart(lineNumWidth, " ");
					return `${lineNum} ${line}`;
				})
				.join("\n");

			// Build output with CRC header
			let text = `${formatted}\n[crc:${crc} lines:${totalLines}]`;

			if (truncated) {
				const nextOffset = startLine + shownLines;
				text += `\n\n[Showing lines ${startLine}-${startLine + shownLines - 1} of ${totalLines} (truncated). Use offset=${nextOffset} to continue.]`;
			} else if (limit !== undefined && endIndex < allLines.length) {
				const remaining = allLines.length - endIndex;
				const nextOffset = endIndex + 1;
				text += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
			}

			return {
				content: [{ type: "text", text }] as TextContent[],
				details: undefined,
			};
		},
	});

	// Register edit tool
	pi.registerTool({
		name: "edit",
		label: "edit",
		description:
			"Edit a file using line numbers from the read tool output. The crc field verifies the file hasn't changed since you read it. Each edit specifies a line range (startLine:endLine) and replacement text. For single-line edits, set endLine=startLine.",
		promptSnippet: "Edit files using line ranges and file CRC (token-efficient, no need to repeat old text)",
		promptGuidelines: [
			"Use edit with line numbers from the read tool output.",
			"Pass the file CRC from the read output to verify the file hasn't changed.",
			"For single-line edits: startLine=endLine.",
			"For multi-line edits: specify the full range. The entire range is replaced by `new`.",
			"To delete lines, set `new` to an empty string.",
			"To insert before a line, set startLine=endLine=target and new=inserted_lines + original_line.",
			"If the CRC doesn't match, re-read the file.",
			"Multiple edits in one call must not overlap. They are applied in reverse line order.",
		],
		parameters: editSchema,

		async execute(_toolCallId, params, signal) {
			const { path, crc, edits } = params;
			const absolutePath = resolve(process.cwd(), path);

			if (!edits || edits.length === 0) {
				throw new Error("edits array must contain at least one entry.");
			}

			return withFileMutationQueue(absolutePath, async () => {
				if (signal?.aborted) throw new Error("Operation aborted");

				try {
					await access(absolutePath, constants.R_OK | constants.W_OK);
				} catch (error: any) {
					const code = error.code || "UNKNOWN";
					throw new Error(`Could not edit file: ${path}. Error code: ${code}.`);
				}

				if (signal?.aborted) throw new Error("Operation aborted");

				const content = await readFile(absolutePath, "utf-8");

				// Verify file CRC
				const currentCrc = fileCrc(content);
				if (crc !== currentCrc) {
					throw new Error(
						`File CRC mismatch for ${path}. Expected "${crc}", got "${currentCrc}". The file has changed since you read it — re-read it.`,
					);
				}

				const lines = content.split("\n");

				if (signal?.aborted) throw new Error("Operation aborted");

				// Validate all edits
				for (let i = 0; i < edits.length; i++) {
					const edit = edits[i] as EditEntry;
					if (edit.startLine < 1 || edit.startLine > lines.length) {
						throw new Error(
							`edits[${i}]: startLine ${edit.startLine} is out of range (file has ${lines.length} lines).`,
						);
					}
					if (edit.endLine < edit.startLine || edit.endLine > lines.length) {
						throw new Error(
							`edits[${i}]: endLine ${edit.endLine} is out of range (startLine=${edit.startLine}, file has ${lines.length} lines).`,
						);
					}
				}

				// Sort edits by startLine descending (apply from bottom to top)
				const sortedEdits = [...edits].sort(
					(a: EditEntry, b: EditEntry) => b.startLine - a.startLine,
				);

				// Check for overlaps
				for (let i = 1; i < sortedEdits.length; i++) {
					const prev = sortedEdits[i - 1] as EditEntry;
					const curr = sortedEdits[i] as EditEntry;
					if (curr.endLine >= prev.startLine) {
						throw new Error(
							`Overlapping edits: lines ${curr.startLine}-${curr.endLine} overlap with lines ${prev.startLine}-${prev.endLine}. Merge them into one edit.`,
						);
					}
				}

				// Apply edits
				const newLines = [...lines];
				for (const edit of sortedEdits as EditEntry[]) {
					const startIdx = edit.startLine - 1;
					const endIdx = edit.endLine - 1;
					const deleteCount = endIdx - startIdx + 1;
					const replacementLines = edit.new === "" ? [] : edit.new.split("\n");
					newLines.splice(startIdx, deleteCount, ...replacementLines);
				}

				const newContent = newLines.join("\n");

				if (content === newContent) {
					throw new Error(`No changes made to ${path}. The replacement produced identical content.`);
				}

				if (signal?.aborted) throw new Error("Operation aborted");

				await writeFile(absolutePath, newContent, "utf-8");

				// Generate diff matching built-in EditToolDetails format
				const diffResult = generateDiffString(content, newContent);
				const patch = generateUnifiedPatch(path, content, newContent);
				const details: EditToolDetails = { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine };

				return {
					content: [
						{
							type: "text",
							text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
						},
					] as TextContent[],
					details,
				};
			});
		},
	});
}
