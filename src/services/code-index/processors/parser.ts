import { readFile, stat } from "fs/promises"
import { createHash } from "crypto"
import * as path from "path"
import * as yaml from "yaml"
import { Node } from "web-tree-sitter"
import { LanguageParser, loadRequiredLanguageParsers } from "../../tree-sitter/languageParser"
import { parseMarkdown } from "../../tree-sitter/markdownParser"
import { ICodeParser, CodeBlock } from "../interfaces"
import { scannerExtensions, shouldUseFallbackChunking } from "../shared/supported-extensions"
import {
	MAX_BLOCK_CHARS,
	MIN_BLOCK_CHARS,
	MIN_CHUNK_REMAINDER_CHARS,
	MAX_CHARS_TOLERANCE_FACTOR,
	MAX_PARSEABLE_FILE_SIZE_BYTES,
	PARSER_LOAD_TIMEOUT_MS,
} from "../constants"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"
import { sanitizeErrorMessage } from "../shared/validation-helpers"

/**
 * Implementation of the code parser interface
 */
export class CodeParser implements ICodeParser {
	private loadedParsers: LanguageParser = {}
	private pendingLoads: Map<string, Promise<LanguageParser>> = new Map()
	// Markdown files are now supported using the custom markdown parser
	// which extracts headers and sections for semantic indexing

	/**
	 * Parses a code file into code blocks
	 * @param filePath Path to the file to parse
	 * @param options Optional parsing options
	 * @returns Promise resolving to array of code blocks
	 */
	async parseFile(
		filePath: string,
		options?: {
			content?: string
			fileHash?: string
			maxFileSizeBytes?: number
		},
	): Promise<CodeBlock[]> {
		// Get file extension
		const ext = path.extname(filePath).toLowerCase()

		// Skip if not a supported language
		if (!this.isSupportedLanguage(ext)) {
			return []
		}

		// Get file content
		let content: string
		let fileHash: string

		const maxFileSizeBytes = options?.maxFileSizeBytes ?? MAX_PARSEABLE_FILE_SIZE_BYTES

		if (options?.content) {
			content = options.content
			fileHash = options.fileHash || this.createFileHash(content)
		} else {
			try {
				// Defense-in-depth: check file size before reading to prevent OOM.
				// Both scanner and file-watcher already guard size, but the parser
				// can be called directly.
				const fileStat = await stat(filePath)
				if (fileStat.size > maxFileSizeBytes) {
					console.warn(
						`[CodeParser] Skipping file too large for parsing: ${filePath} (${fileStat.size} bytes, limit ${maxFileSizeBytes})`,
					)
					return []
				}
				content = await readFile(filePath, "utf8")
				fileHash = this.createFileHash(content)
			} catch (error) {
				console.error(`Error reading file ${filePath}:`, error)
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
					stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
					location: "parseFile",
				})
				return []
			}
		}

		const contentBytes = Buffer.byteLength(content, "utf8")
		if (contentBytes > maxFileSizeBytes) {
			console.warn(
				`[CodeParser] Skipping file too large for parsing: ${filePath} (${contentBytes} bytes, limit ${maxFileSizeBytes})`,
			)
			return []
		}

		// Parse the file
		return this.parseContent(filePath, content, fileHash)
	}

	/**
	 * Checks if a language is supported
	 * @param extension File extension
	 * @returns Boolean indicating if the language is supported
	 */
	private isSupportedLanguage(extension: string): boolean {
		return scannerExtensions.includes(extension)
	}

	/**
	 * Creates a hash for a file
	 * @param content File content
	 * @returns Hash string
	 */
	private createFileHash(content: string): string {
		return createHash("sha256").update(content).digest("hex")
	}

	/**
	 * Wraps a parser load promise with a timeout to prevent indefinite hangs.
	 * If a WASM parser load takes longer than PARSER_LOAD_TIMEOUT_MS, the
	 * pending promise is evicted from the cache and an error is thrown.
	 */
	private _withParserLoadTimeout<T>(promise: Promise<T>, ext: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				// Evict the hung promise so future requests retry
				this.pendingLoads.delete(ext)
				reject(new Error(`Parser load for .${ext} timed out after ${PARSER_LOAD_TIMEOUT_MS}ms`))
			}, PARSER_LOAD_TIMEOUT_MS)

			promise.then(
				(value) => {
					clearTimeout(timer)
					resolve(value)
				},
				(error) => {
					clearTimeout(timer)
					reject(error)
				},
			)
		})
	}

	/**
	 * Parses file content into code blocks
	 * @param filePath Path to the file
	 * @param content File content
	 * @param fileHash File hash
	 * @returns Array of code blocks
	 */
	private async parseContent(filePath: string, content: string, fileHash: string): Promise<CodeBlock[]> {
		const ext = path.extname(filePath).slice(1).toLowerCase()
		const seenSegmentHashes = new Set<string>()

		// Handle markdown files specially
		if (ext === "md" || ext === "markdown") {
			return this.parseMarkdownContent(filePath, content, fileHash, seenSegmentHashes)
		}

		// Handle structured config files specially
		if (ext === "json" || ext === "yaml" || ext === "yml" || ext === "toml") {
			const structuredBlocks = this.parseStructuredConfigContent(
				filePath,
				content,
				fileHash,
				seenSegmentHashes,
				ext,
			)
			if (structuredBlocks.length > 0) {
				return structuredBlocks
			}
		}

		// Check if this extension should use fallback chunking
		if (shouldUseFallbackChunking(`.${ext}`)) {
			return this._performFallbackChunking(filePath, content, fileHash, seenSegmentHashes)
		}

		// Check if we already have the parser loaded
		if (!this.loadedParsers[ext]) {
			const pendingLoad = this.pendingLoads.get(ext)
			if (pendingLoad) {
				try {
					await this._withParserLoadTimeout(pendingLoad, ext)
				} catch (error) {
					console.error(`Error in pending parser load for ${filePath}:`, error)
					TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
						error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
						stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
						location: "parseContent:loadParser",
					})
					return []
				}
			} else {
				const loadPromise = loadRequiredLanguageParsers([filePath])
				this.pendingLoads.set(ext, loadPromise)
				try {
					const newParsers = await this._withParserLoadTimeout(loadPromise, ext)
					if (newParsers) {
						this.loadedParsers = { ...this.loadedParsers, ...newParsers }
					}
				} catch (error) {
					console.error(`Error loading language parser for ${filePath}:`, error)
					TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
						error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
						stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
						location: "parseContent:loadParser",
					})
					return []
				} finally {
					this.pendingLoads.delete(ext)
				}
			}
		}

		const language = this.loadedParsers[ext]
		if (!language) {
			console.warn(`No parser available for file extension: ${ext}`)
			return []
		}

		const tree = language.parser.parse(content)

		// We don't need to get the query string from languageQueries since it's already loaded
		// in the language object
		const captures = tree ? language.query.captures(tree.rootNode) : []

		// Check if captures are empty
		if (captures.length === 0) {
			if (content.length >= MIN_BLOCK_CHARS) {
				// Perform fallback chunking if content is large enough
				const blocks = this._performFallbackChunking(filePath, content, fileHash, seenSegmentHashes)
				return blocks
			} else {
				// Return empty if content is too small for fallback
				return []
			}
		}

		const results: CodeBlock[] = []

		// Process captures if not empty
		const queue: Node[] = Array.from(captures).map((capture) => capture.node)

		while (queue.length > 0) {
			const currentNode = queue.shift()!
			// const lineSpan = currentNode.endPosition.row - currentNode.startPosition.row + 1 // Removed as per lint error

			// Check if the node meets the minimum character requirement
			if (currentNode.text.length >= MIN_BLOCK_CHARS) {
				// If it also exceeds the maximum character limit, try to break it down
				if (currentNode.text.length > MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR) {
					if (currentNode.children.filter((child) => child !== null).length > 0) {
						// If it has children, process them instead
						queue.push(...currentNode.children.filter((child) => child !== null))
					} else {
						// If it's a leaf node, chunk it
						const chunkedBlocks = this._chunkLeafNodeByLines(
							currentNode,
							filePath,
							fileHash,
							seenSegmentHashes,
						)
						results.push(...chunkedBlocks)
					}
				} else {
					// Node meets min chars and is within max chars, create a block
					const identifier = this.getNodeIdentifier(currentNode)
					const parentSymbol = this.findParentSymbol(filePath, currentNode)
					const type = currentNode.type
					const start_line = currentNode.startPosition.row + 1
					const end_line = currentNode.endPosition.row + 1
					const content = currentNode.text
					const contentPreview = content.slice(0, 100)
					const segmentHash = createHash("sha256")
						.update(`${filePath}-${start_line}-${end_line}-${content.length}-${contentPreview}`)
						.digest("hex")

					if (!seenSegmentHashes.has(segmentHash)) {
						seenSegmentHashes.add(segmentHash)
						results.push({
							file_path: filePath,
							identifier,
							parentIdentifier: parentSymbol?.identifier ?? null,
							parentChunkFingerprint: parentSymbol?.chunkFingerprint ?? null,
							type,
							start_line,
							end_line,
							content,
							segmentHash,
							fileHash,
						})
					}
				}
			}
			// Nodes smaller than minBlockChars are ignored
		}

		return results
	}

	/**
	 * Common helper function to chunk text by lines, avoiding tiny remainders.
	 */
	private _chunkTextByLines(
		lines: string[],
		filePath: string,
		fileHash: string,
		chunkType: string,
		seenSegmentHashes: Set<string>,
		baseStartLine: number = 1, // 1-based start line of the *first* line in the `lines` array
		identifier: string | null = null,
		parentIdentifier: string | null = null,
		parentChunkFingerprint: string | null = null,
	): CodeBlock[] {
		const chunks: CodeBlock[] = []
		let currentChunkLines: string[] = []
		let currentChunkLength = 0
		let chunkStartLineIndex = 0 // 0-based index within the `lines` array
		const effectiveMaxChars = MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR

		const finalizeChunk = (endLineIndex: number) => {
			if (currentChunkLength >= MIN_BLOCK_CHARS && currentChunkLines.length > 0) {
				const chunkContent = currentChunkLines.join("\n")
				const startLine = baseStartLine + chunkStartLineIndex
				const endLine = baseStartLine + endLineIndex
				const contentPreview = chunkContent.slice(0, 100)
				const segmentHash = createHash("sha256")
					.update(`${filePath}-${startLine}-${endLine}-${chunkContent.length}-${contentPreview}`)
					.digest("hex")

				if (!seenSegmentHashes.has(segmentHash)) {
					seenSegmentHashes.add(segmentHash)
					chunks.push({
						file_path: filePath,
						identifier,
						parentIdentifier,
						parentChunkFingerprint,
						type: chunkType,
						start_line: startLine,
						end_line: endLine,
						content: chunkContent,
						segmentHash,
						fileHash,
					})
				}
			}
			currentChunkLines = []
			currentChunkLength = 0
			chunkStartLineIndex = endLineIndex + 1
		}

		const createSegmentBlock = (segment: string, originalLineNumber: number, startCharIndex: number) => {
			const segmentPreview = segment.slice(0, 100)
			const segmentHash = createHash("sha256")
				.update(
					`${filePath}-${originalLineNumber}-${originalLineNumber}-${startCharIndex}-${segment.length}-${segmentPreview}`,
				)
				.digest("hex")

			if (!seenSegmentHashes.has(segmentHash)) {
				seenSegmentHashes.add(segmentHash)
				chunks.push({
					file_path: filePath,
					identifier,
					parentIdentifier,
					parentChunkFingerprint,
					type: `${chunkType}_segment`,
					start_line: originalLineNumber,
					end_line: originalLineNumber,
					content: segment,
					segmentHash,
					fileHash,
				})
			}
		}

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]
			const lineLength = line.length + (i < lines.length - 1 ? 1 : 0) // +1 for newline, except last line
			const originalLineNumber = baseStartLine + i

			// Handle oversized lines (longer than effectiveMaxChars)
			if (lineLength > effectiveMaxChars) {
				// Finalize any existing normal chunk before processing the oversized line
				if (currentChunkLines.length > 0) {
					finalizeChunk(i - 1)
				}

				// Split the oversized line into segments
				let remainingLineContent = line
				let currentSegmentStartChar = 0
				while (remainingLineContent.length > 0) {
					const segment = remainingLineContent.substring(0, MAX_BLOCK_CHARS)
					remainingLineContent = remainingLineContent.substring(MAX_BLOCK_CHARS)
					createSegmentBlock(segment, originalLineNumber, currentSegmentStartChar)
					currentSegmentStartChar += MAX_BLOCK_CHARS
				}
				// Update chunkStartLineIndex to continue processing from the next line
				chunkStartLineIndex = i + 1
				continue
			}

			// Handle normally sized lines
			if (currentChunkLength > 0 && currentChunkLength + lineLength > effectiveMaxChars) {
				// Re-balancing Logic
				let splitIndex = i - 1
				let remainderLength = 0
				for (let j = i; j < lines.length; j++) {
					remainderLength += lines[j].length + (j < lines.length - 1 ? 1 : 0)
				}

				if (
					currentChunkLength >= MIN_BLOCK_CHARS &&
					remainderLength < MIN_CHUNK_REMAINDER_CHARS &&
					currentChunkLines.length > 1
				) {
					for (let k = i - 2; k >= chunkStartLineIndex; k--) {
						const potentialChunkLines = lines.slice(chunkStartLineIndex, k + 1)
						const potentialChunkLength = potentialChunkLines.join("\n").length + 1
						const potentialNextChunkLines = lines.slice(k + 1)
						const potentialNextChunkLength = potentialNextChunkLines.join("\n").length + 1

						if (
							potentialChunkLength >= MIN_BLOCK_CHARS &&
							potentialNextChunkLength >= MIN_CHUNK_REMAINDER_CHARS
						) {
							splitIndex = k
							break
						}
					}
				}

				finalizeChunk(splitIndex)

				if (i >= chunkStartLineIndex) {
					currentChunkLines.push(line)
					currentChunkLength += lineLength
				} else {
					i = chunkStartLineIndex - 1
					continue
				}
			} else {
				currentChunkLines.push(line)
				currentChunkLength += lineLength
			}
		}

		// Process the last remaining chunk
		if (currentChunkLines.length > 0) {
			finalizeChunk(lines.length - 1)
		}

		return chunks
	}

	private _performFallbackChunking(
		filePath: string,
		content: string,
		fileHash: string,
		seenSegmentHashes: Set<string>,
	): CodeBlock[] {
		const lines = content.split("\n")
		return this._chunkTextByLines(lines, filePath, fileHash, "fallback_chunk", seenSegmentHashes)
	}

	private _chunkLeafNodeByLines(
		node: Node,
		filePath: string,
		fileHash: string,
		seenSegmentHashes: Set<string>,
	): CodeBlock[] {
		const lines = node.text.split("\n")
		const baseStartLine = node.startPosition.row + 1
		const identifier = this.getNodeIdentifier(node)
		const parentSymbol = this.findParentSymbol(filePath, node)
		return this._chunkTextByLines(
			lines,
			filePath,
			fileHash,
			node.type, // Use the node's type
			seenSegmentHashes,
			baseStartLine,
			identifier,
			parentSymbol?.identifier ?? null,
			parentSymbol?.chunkFingerprint ?? null,
		)
	}

	/**
	 * Helper method to process markdown content sections with consistent chunking logic
	 */
	private processMarkdownSection(
		lines: string[],
		filePath: string,
		fileHash: string,
		type: string,
		seenSegmentHashes: Set<string>,
		startLine: number,
		identifier: string | null = null,
	): CodeBlock[] {
		const content = lines.join("\n")

		if (content.trim().length < MIN_BLOCK_CHARS) {
			return []
		}

		// Check if content needs chunking (either total size or individual line size)
		const needsChunking =
			content.length > MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR ||
			lines.some((line) => line.length > MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR)

		if (needsChunking) {
			// Apply chunking for large content or oversized lines
			const chunks = this._chunkTextByLines(lines, filePath, fileHash, type, seenSegmentHashes, startLine)
			// Preserve identifier in all chunks if provided
			if (identifier) {
				chunks.forEach((chunk) => {
					chunk.identifier = identifier
				})
			}
			return chunks
		}

		// Create a single block for normal-sized content with no oversized lines
		const endLine = startLine + lines.length - 1
		const contentPreview = content.slice(0, 100)
		const segmentHash = createHash("sha256")
			.update(`${filePath}-${startLine}-${endLine}-${content.length}-${contentPreview}`)
			.digest("hex")

		if (!seenSegmentHashes.has(segmentHash)) {
			seenSegmentHashes.add(segmentHash)
			return [
				{
					file_path: filePath,
					identifier,
					parentIdentifier: null,
					parentChunkFingerprint: null,
					type,
					start_line: startLine,
					end_line: endLine,
					content,
					segmentHash,
					fileHash,
				},
			]
		}

		return []
	}

	private parseMarkdownContent(
		filePath: string,
		content: string,
		fileHash: string,
		seenSegmentHashes: Set<string>,
	): CodeBlock[] {
		const lines = content.split("\n")
		const markdownCaptures = parseMarkdown(content) || []

		if (markdownCaptures.length === 0) {
			// No headers found, process entire content
			return this.processMarkdownSection(lines, filePath, fileHash, "markdown_content", seenSegmentHashes, 1)
		}

		const results: CodeBlock[] = []
		let lastProcessedLine = 0

		// Process content before the first header
		if (markdownCaptures.length > 0) {
			const firstHeaderLine = markdownCaptures[0].node.startPosition.row
			if (firstHeaderLine > 0) {
				const preHeaderLines = lines.slice(0, firstHeaderLine)
				const preHeaderBlocks = this.processMarkdownSection(
					preHeaderLines,
					filePath,
					fileHash,
					"markdown_content",
					seenSegmentHashes,
					1,
				)
				results.push(...preHeaderBlocks)
			}
		}

		// Process markdown captures (headers and sections)
		for (let i = 0; i < markdownCaptures.length; i += 2) {
			const nameCapture = markdownCaptures[i]
			// Ensure we don't go out of bounds when accessing the next capture
			if (i + 1 >= markdownCaptures.length) break
			const definitionCapture = markdownCaptures[i + 1]

			if (!definitionCapture) continue

			const startLine = definitionCapture.node.startPosition.row + 1
			const endLine = definitionCapture.node.endPosition.row + 1
			const sectionLines = lines.slice(startLine - 1, endLine)

			// Extract header level for type classification
			const headerMatch = nameCapture.name.match(/\.h(\d)$/)
			const headerLevel = headerMatch ? parseInt(headerMatch[1]) : 1
			const headerText = nameCapture.node.text

			const sectionBlocks = this.processMarkdownSection(
				sectionLines,
				filePath,
				fileHash,
				`markdown_header_h${headerLevel}`,
				seenSegmentHashes,
				startLine,
				headerText,
			)
			results.push(...sectionBlocks)

			lastProcessedLine = endLine
		}

		// Process any remaining content after the last header section
		if (lastProcessedLine < lines.length) {
			const remainingLines = lines.slice(lastProcessedLine)
			const remainingBlocks = this.processMarkdownSection(
				remainingLines,
				filePath,
				fileHash,
				"markdown_content",
				seenSegmentHashes,
				lastProcessedLine + 1,
			)
			results.push(...remainingBlocks)
		}

		return results
	}

	private parseStructuredConfigContent(
		filePath: string,
		content: string,
		fileHash: string,
		seenSegmentHashes: Set<string>,
		ext: string,
	): CodeBlock[] {
		const lines = content.split("\n")
		switch (ext) {
			case "json":
				return this.parseJsonContent(filePath, content, fileHash, seenSegmentHashes, lines)
			case "yaml":
			case "yml":
				return this.parseYamlContent(filePath, content, fileHash, seenSegmentHashes, lines)
			case "toml":
				return this.parseTomlContent(filePath, content, fileHash, seenSegmentHashes, lines)
			default:
				return []
		}
	}

	private parseJsonContent(
		filePath: string,
		content: string,
		fileHash: string,
		seenSegmentHashes: Set<string>,
		lines: string[],
	): CodeBlock[] {
		let parsed: unknown
		try {
			parsed = JSON.parse(content)
		} catch {
			return []
		}

		if (Array.isArray(parsed)) {
			const results: CodeBlock[] = []
			for (let index = 0; index < parsed.length; index++) {
				const item = parsed[index]
				const itemText = JSON.stringify(item, null, 2)
				if (!itemText) {
					continue
				}
				const identifier = `[${index}]`
				const startLine = this.findLineIndex(lines, new RegExp(`^\\s*\\{?\\s*$`), 1) || 1
				const blocks = this.processStructuredSection(
					filePath,
					fileHash,
					seenSegmentHashes,
					itemText,
					startLine,
					`json_array_item`,
					identifier,
				)
				results.push(...blocks)
			}
			return results
		}

		if (!parsed || typeof parsed !== "object") {
			return []
		}

		const results: CodeBlock[] = []
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			const itemText = JSON.stringify({ [key]: value }, null, 2)
			const startLine = this.findLineIndex(lines, new RegExp(`^\\s*"${this.escapeRegex(key)}"\\s*:`), 1) || 1
			results.push(
				...this.processStructuredSection(
					filePath,
					fileHash,
					seenSegmentHashes,
					itemText,
					startLine,
					"json_key",
					key,
				),
			)
		}
		return results
	}

	private parseYamlContent(
		filePath: string,
		content: string,
		fileHash: string,
		seenSegmentHashes: Set<string>,
		lines: string[],
	): CodeBlock[] {
		try {
			yaml.parse(content)
		} catch {
			return []
		}

		const topLevelKeyIndices = lines
			.map((line, index) => {
				const match = line.match(/^([A-Za-z0-9_.-]+)\s*:/)
				return match ? { key: match[1], index } : null
			})
			.filter((entry): entry is { key: string; index: number } => entry !== null)

		const results: CodeBlock[] = []
		for (let i = 0; i < topLevelKeyIndices.length; i++) {
			const current = topLevelKeyIndices[i]
			const next = topLevelKeyIndices[i + 1]
			const sectionLines = lines.slice(current.index, next?.index ?? lines.length)
			results.push(
				...this.processStructuredSection(
					filePath,
					fileHash,
					seenSegmentHashes,
					sectionLines.join("\n"),
					current.index + 1,
					"yaml_key",
					current.key,
				),
			)
		}

		return results
	}

	private parseTomlContent(
		filePath: string,
		content: string,
		fileHash: string,
		seenSegmentHashes: Set<string>,
		lines: string[],
	): CodeBlock[] {
		const sectionIndices = lines
			.map((line, index) => {
				const match = line.match(/^\s*\[([^\]]+)\]\s*$/)
				return match ? { key: match[1], index } : null
			})
			.filter((entry): entry is { key: string; index: number } => entry !== null)

		const results: CodeBlock[] = []
		for (let i = 0; i < sectionIndices.length; i++) {
			const current = sectionIndices[i]
			const next = sectionIndices[i + 1]
			const sectionLines = lines.slice(current.index, next?.index ?? lines.length)
			results.push(
				...this.processStructuredSection(
					filePath,
					fileHash,
					seenSegmentHashes,
					sectionLines.join("\n"),
					current.index + 1,
					"toml_table",
					current.key,
				),
			)
		}

		if (results.length === 0) {
			const rootLines = lines.filter((line) => line.trim().length > 0)
			return this.processStructuredSection(
				filePath,
				fileHash,
				seenSegmentHashes,
				rootLines.join("\n"),
				1,
				"toml_content",
				null,
			)
		}

		return results
	}

	private processStructuredSection(
		filePath: string,
		fileHash: string,
		seenSegmentHashes: Set<string>,
		content: string,
		startLine: number,
		type: string,
		identifier: string | null,
	): CodeBlock[] {
		const normalizedContent = content.trim()
		if (normalizedContent.length < MIN_BLOCK_CHARS) {
			return []
		}

		const lines = normalizedContent.split("\n")
		return this.processMarkdownSection(lines, filePath, fileHash, type, seenSegmentHashes, startLine, identifier)
	}

	private findLineIndex(lines: string[], pattern: RegExp, fallbackLine: number): number {
		const index = lines.findIndex((line) => pattern.test(line))
		return index >= 0 ? index + 1 : fallbackLine
	}

	private escapeRegex(value: string): string {
		return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	}

	private getNodeIdentifier(node: Node | null | undefined): string | null {
		if (!node) {
			return null
		}
		return (
			node.childForFieldName?.("name")?.text || node.children?.find((c) => c?.type === "identifier")?.text || null
		)
	}

	private findParentSymbol(
		filePath: string,
		node: Node | null | undefined,
	): { identifier: string; chunkFingerprint: string } | null {
		let current = node?.parent
		while (current) {
			const identifier = this.getNodeIdentifier(current)
			if (identifier) {
				return {
					identifier,
					chunkFingerprint: this.createNodeSegmentHash(filePath, current, current.text || ""),
				}
			}
			current = current.parent
		}
		return null
	}

	private createNodeSegmentHash(filePath: string, node: Node, content: string): string {
		const startLine = node.startPosition?.row !== undefined ? node.startPosition.row + 1 : 0
		const endLine = node.endPosition?.row !== undefined ? node.endPosition.row + 1 : startLine
		const contentPreview = content.slice(0, 100)
		return createHash("sha256")
			.update(`${filePath}-${startLine}-${endLine}-${content.length}-${contentPreview}`)
			.digest("hex")
	}
}

// Export a singleton instance for convenience
export const codeParser = new CodeParser()
