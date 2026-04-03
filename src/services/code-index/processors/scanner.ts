import { listFiles } from "../../glob/list-files"
import { Ignore } from "ignore"
import { RooIgnoreController } from "../../../core/ignore/RooIgnoreController"
import { stat } from "fs/promises"
import * as path from "path"
import { generateNormalizedAbsolutePath, generateRelativeFilePath } from "../shared/get-relative-path"
import { getWorkspacePathForContext } from "../../../utils/path"
import { scannerExtensions } from "../shared/supported-extensions"
import * as vscode from "vscode"
import {
	CodeBlock,
	ICodeParser,
	IEmbedder,
	IVectorStore,
	IDirectoryScanner,
	ScanProgress,
	ScanResult,
} from "../interfaces"
import { createHash } from "crypto"
import { v5 as uuidv5 } from "uuid"
import pLimit from "p-limit"
import { CacheManager } from "../cache-manager"
import { t } from "../../../i18n"
import {
	QDRANT_CODE_BLOCK_NAMESPACE,
	MAX_FILE_SIZE_BYTES,
	MAX_LIST_FILES_LIMIT_CODE_INDEX,
	BATCH_SEGMENT_THRESHOLD,
	MAX_BATCH_RETRIES,
	INITIAL_RETRY_DELAY_MS,
	PARSING_CONCURRENCY,
	PARSE_CHUNK_SIZE,
	PROGRESS_THROTTLE_MS,
	BATCH_PROCESSING_CONCURRENCY,
	MAX_PENDING_BATCHES,
	MAX_EMBED_QUEUE_FILES,
	MAX_CONSECUTIVE_BATCH_FAILURES,
	BATCH_PROCESSING_TIMEOUT_MS,
	CLIENT_RECYCLE_INTERVAL,
} from "../constants"
import { isPathInIgnoredDirectory } from "../../glob/ignore-utils"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"
import { sanitizeErrorMessage } from "../shared/validation-helpers"
import { Package } from "../../../shared/package"
import { BoundedChannel } from "./bounded-channel"
import { IndexDebugLogger } from "../debug-logger"
import { getIsolatedFetchStats } from "../utils/isolated-fetch"

// ─── Internal Types ──────────────────────────────────────────────────────────

/** A file that passed stat but needs mtime/hash/parse checking. */
interface StatEntry {
	filePath: string
	normalizedPath: string
	size: number
	mtimeMs: number
}

/** A parsed file's blocks ready for embedding. */
interface EmbedWork {
	blocks: CodeBlock[]
	filePath: string
	fileHash: string
	mtimeMs: number
	isNew: boolean
}

// ─── Scanner ─────────────────────────────────────────────────────────────────

export class DirectoryScanner implements IDirectoryScanner {
	private readonly batchSegmentThreshold: number
	private readonly maxFilesLimit: number
	private _batchCount = 0

	// Event emitters for progress and errors
	private readonly _progressEmitter = new vscode.EventEmitter<ScanProgress>()
	private readonly _errorEmitter = new vscode.EventEmitter<Error>()

	public readonly onProgress = this._progressEmitter.event
	public readonly onError = this._errorEmitter.event

	constructor(
		private readonly embedder: IEmbedder,
		private readonly qdrantClient: IVectorStore,
		private readonly codeParser: ICodeParser,
		private readonly cacheManager: CacheManager,
		private readonly ignoreInstance: Ignore,
		batchSegmentThreshold?: number,
	) {
		if (batchSegmentThreshold !== undefined) {
			this.batchSegmentThreshold = batchSegmentThreshold
		} else {
			try {
				this.batchSegmentThreshold = vscode.workspace
					.getConfiguration(Package.name)
					.get<number>("codeIndex.embeddingBatchSize", BATCH_SEGMENT_THRESHOLD)
			} catch {
				this.batchSegmentThreshold = BATCH_SEGMENT_THRESHOLD
			}
		}

		try {
			this.maxFilesLimit = vscode.workspace
				.getConfiguration(Package.name)
				.get<number>("codeIndex.maxFiles", MAX_LIST_FILES_LIMIT_CODE_INDEX)
		} catch {
			this.maxFilesLimit = MAX_LIST_FILES_LIMIT_CODE_INDEX
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Three-phase indexing pipeline:
	 *   Phase 1 — Discover: list, filter, stat, classify (unchanged vs candidate)
	 *   Phase 2 — Parse:    read, hash, parse candidates (parseLimiter, no embed wait)
	 *   Phase 3 — Embed:    batch, embed, upsert (concurrent with Phase 2 via BoundedChannel)
	 */
	public async scanDirectory(directory: string, signal: AbortSignal): Promise<ScanResult> {
		const scanWorkspace = getWorkspacePathForContext(directory)
		const errors: Error[] = []

		// ── Phase 1: Discover ──────────────────────────────────────────────
		const discovery = await this._discover(directory, scanWorkspace, signal)
		if (signal.aborted) {
			return this._abortedResult(discovery)
		}

		IndexDebugLogger.log("Scanner", "discovery-complete", {
			totalFiles: discovery.totalFiles,
			unchangedCount: discovery.unchangedCount,
			candidateCount: discovery.candidates.length,
			totalBytes: discovery.totalBytes,
		})

		// If no candidates, skip Phase 2 & 3 entirely
		if (discovery.candidates.length === 0) {
			// Still need to handle deleted files
			await this._handleDeletedFiles(discovery.processedPaths, scanWorkspace, signal, errors)

			this._emitProgress({
				phase: "complete",
				filesChecked: discovery.totalFiles,
				totalFiles: discovery.totalFiles,
				blocksEmbedded: 0,
				totalBlocksEstimate: 0,
				isEstimatedTotal: false,
			})

			return {
				totalFiles: discovery.totalFiles,
				processedFiles: 0,
				skippedFiles: discovery.unchangedCount,
				totalBlocks: 0,
				blocksEmbedded: 0,
				errors,
			}
		}

		// ── Phase 2 + 3: Parse and Embed (concurrent) ─────────────────────
		const channel = new BoundedChannel<EmbedWork>(MAX_EMBED_QUEUE_FILES)

		// Block count for unchanged files (mtime-matched during discovery).
		// Candidates (no mtime match) are a DISJOINT set — their blocks come
		// via blocksFound during parse. Total = unchangedBlockCount + blocksFound.
		const unchangedBlockCount = discovery.unchangedBlockCount

		// Mutable progress counters — Phase 2 updates filesChecked/blocksFound,
		// Phase 3 updates blocksEmbedded. Both fire progress events independently.
		let filesChecked = discovery.unchangedCount
		let blocksFound = 0
		let blocksEmbedded = 0
		let processedCount = 0
		let isEstimated = true
		let embedPhaseStarted = false

		// Total estimate = unchanged (mtime-matched) + found (candidates parsed so far).
		// These are strictly disjoint: unchanged = mtime match, candidates = no mtime match.
		const getTotalEstimate = () => unchangedBlockCount + blocksFound

		// Fix 2: Throttle progress events to prevent event storm (4/sec max).
		// Phase transitions ("embedding" start) and completion always fire immediately.
		let lastProgressTime = 0
		let lastProgressPhase = ""

		const reportProgress = (forceEmit = false) => {
			const now = Date.now()
			const currentPhase = embedPhaseStarted ? "embedding" : "parsing"
			const isPhaseTransition = currentPhase !== lastProgressPhase

			if (!forceEmit && !isPhaseTransition && now - lastProgressTime < PROGRESS_THROTTLE_MS) {
				return // Throttled — skip this event
			}

			lastProgressTime = now
			lastProgressPhase = currentPhase

			this._emitProgress({
				phase: currentPhase,
				filesChecked,
				totalFiles: discovery.totalFiles,
				blocksEmbedded,
				totalBlocksEstimate: getTotalEstimate(),
				isEstimatedTotal: isEstimated,
			})
		}

		// Start Phase 3: Embed consumer (runs concurrently with Phase 2)
		const embedPromise = this._runEmbedPhase(
			channel,
			scanWorkspace,
			signal,
			(count: number) => {
				blocksEmbedded += count
				IndexDebugLogger.log("Scanner", "blocks-embedded", {
					batchSize: count,
					blocksEmbedded,
					totalBlockEstimate: getTotalEstimate(),
					filesChecked,
					totalFiles: discovery.totalFiles,
				})
				reportProgress()
			},
			errors,
		)

		// Run Phase 2: Parse producer
		const parseResult = await this._runParsePhase(
			discovery.candidates,
			discovery.processedPaths,
			scanWorkspace,
			signal,
			channel,
			(fileBlockCount: number) => {
				filesChecked++
				blocksFound += fileBlockCount

				if (!embedPhaseStarted && getTotalEstimate() > 0) {
					embedPhaseStarted = true
				}

				if (fileBlockCount > 0) processedCount++
				reportProgress()
			},
			errors,
		)

		// Close channel — tells embed consumer no more items coming
		channel.close()

		// Wait for all embedding to finish
		await embedPromise

		if (signal.aborted) {
			return {
				totalFiles: discovery.totalFiles,
				processedFiles: processedCount,
				skippedFiles: discovery.unchangedCount + parseResult.hashSkipped,
				totalBlocks: blocksFound,
				blocksEmbedded,
				errors,
			}
		}

		// Now that all files are parsed, total is exact
		isEstimated = false
		reportProgress(true) // Force emit — final count

		// Handle deleted files
		await this._handleDeletedFiles(discovery.processedPaths, scanWorkspace, signal, errors)

		this._emitProgress({
			phase: "complete",
			filesChecked: discovery.totalFiles,
			totalFiles: discovery.totalFiles,
			blocksEmbedded,
			totalBlocksEstimate: getTotalEstimate(),
			isEstimatedTotal: false,
		})

		return {
			totalFiles: discovery.totalFiles,
			processedFiles: processedCount,
			skippedFiles: discovery.unchangedCount + parseResult.hashSkipped,
			totalBlocks: blocksFound,
			blocksEmbedded,
			errors,
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Phase 1: Discover
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Lists files, filters by extension/ignore, stats all, classifies by mtime.
	 * Returns immediately with the classification — no I/O-heavy work.
	 *
	 * Unchanged files are counted instantly (90%+ of 65K files in a typical
	 * incremental scan), so file progress jumps to ~90% within 3 seconds.
	 */
	private async _discover(
		directory: string,
		scanWorkspace: string,
		signal: AbortSignal,
	): Promise<{
		totalFiles: number
		totalBytes: number
		unchangedCount: number
		unchangedBlockCount: number
		candidates: StatEntry[]
		processedPaths: Set<string>
	}> {
		// List all files
		const [allPaths] = await listFiles(directory, true, 500_000)
		const filePaths = allPaths.filter((p) => !p.endsWith("/"))

		// Initialize RooIgnoreController
		const ignoreController = new RooIgnoreController(directory)
		await ignoreController.initialize()
		const allowedPaths = ignoreController.filterPaths(filePaths)

		// Filter by supported extensions and ignore patterns
		let supportedPaths = allowedPaths.filter((filePath) => {
			const ext = path.extname(filePath).toLowerCase()
			const relativeFilePath = generateRelativeFilePath(filePath, scanWorkspace)
			if (isPathInIgnoredDirectory(relativeFilePath)) return false
			return scannerExtensions.includes(ext) && !this.ignoreInstance.ignores(relativeFilePath)
		})

		// Apply file count cap
		if (supportedPaths.length > this.maxFilesLimit) {
			console.warn(`[DirectoryScanner] Capping files from ${supportedPaths.length} to ${this.maxFilesLimit}`)
			supportedPaths = supportedPaths.slice(0, this.maxFilesLimit)
		}

		// Stat all files (fast: ~2 seconds for 65K files)
		const statLimiter = pLimit(50)
		const statEntries: StatEntry[] = []
		let totalBytes = 0
		const processedPaths = new Set<string>()

		await Promise.all(
			supportedPaths.map((filePath) =>
				statLimiter(async () => {
					if (signal.aborted) return
					try {
						const s = await stat(filePath)
						const normalizedPath = path.normalize(filePath)
						processedPaths.add(normalizedPath)
						if (s.size <= MAX_FILE_SIZE_BYTES) {
							totalBytes += s.size
						}
						statEntries.push({
							filePath,
							normalizedPath,
							size: s.size,
							mtimeMs: s.mtimeMs,
						})
					} catch {
						// File vanished between list and stat — skip
					}
				}),
			),
		)

		const totalFiles = statEntries.length

		// Report scan start immediately
		this._emitProgress({
			phase: "discovering",
			filesChecked: 0,
			totalFiles,
			blocksEmbedded: 0,
			totalBlocksEstimate: 0,
			isEstimatedTotal: true,
		})

		// Classify: mtime match → unchanged, otherwise → candidate
		const candidates: StatEntry[] = []
		let unchangedCount = 0

		let unchangedBlockCount = 0

		// Candidate reason counters for diagnostics
		let noCacheEntry = 0
		let mtimeMismatch = 0
		// Sample up to 20 candidate paths for the debug log (path, reason, cached mtime, current mtime)
		const candidateSamples: Array<{ path: string; reason: string; cachedMtime?: number; fileMtime: number }> = []

		for (const entry of statEntries) {
			if (signal.aborted) break

			if (entry.size > MAX_FILE_SIZE_BYTES) {
				unchangedCount++ // Skip large files, count as examined
				continue
			}

			const cachedMtime = this.cacheManager.getMtime(entry.normalizedPath)
			if (cachedMtime !== undefined && cachedMtime === entry.mtimeMs) {
				unchangedCount++
				// Sum cached block count for unchanged files only —
				// candidates will be re-parsed and contribute via blocksFound
				const bc = this.cacheManager.getBlockCount(entry.normalizedPath)
				if (bc !== undefined) unchangedBlockCount += bc
			} else {
				candidates.push(entry)
				if (cachedMtime === undefined) {
					noCacheEntry++
					if (candidateSamples.length < 20) {
						candidateSamples.push({
							path: entry.normalizedPath,
							reason: "noCache",
							fileMtime: entry.mtimeMs,
						})
					}
				} else {
					mtimeMismatch++
					if (candidateSamples.length < 20) {
						candidateSamples.push({
							path: entry.normalizedPath,
							reason: "mtimeMismatch",
							cachedMtime,
							fileMtime: entry.mtimeMs,
						})
					}
				}
			}
		}

		IndexDebugLogger.log("Scanner", "discovery-classify", {
			totalFiles,
			unchangedCount,
			candidateCount: candidates.length,
			noCacheEntry,
			mtimeMismatch,
			cacheHashCount: this.cacheManager.hashCount,
			sampleCandidates: candidateSamples
				.map((s) =>
					s.reason === "noCache"
						? `noCache:${s.path.split("/").slice(-2).join("/")}`
						: `mtimeMismatch:${s.path.split("/").slice(-2).join("/")}(cached=${s.cachedMtime},file=${s.fileMtime})`,
				)
				.join(" | "),
			phaseTransition: true,
		})

		// Report discovery results — file progress jumps to unchangedCount/totalFiles
		this._emitProgress({
			phase: "discovering",
			filesChecked: unchangedCount,
			totalFiles,
			blocksEmbedded: 0,
			totalBlocksEstimate: 0,
			isEstimatedTotal: true,
		})

		return { totalFiles, totalBytes, unchangedCount, unchangedBlockCount, candidates, processedPaths }
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Phase 2: Parse
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * For each candidate file: read → hash → parse. Pushes changed files
	 * to the BoundedChannel for embedding.
	 *
	 * parseLimiter slots release IMMEDIATELY after parse — they never wait
	 * on the embed pipeline. Backpressure happens in channel.push(), which
	 * blocks the awaiting promise in the per-file callback, NOT the
	 * parseLimiter slot (because we use a separate outer promise).
	 *
	 * The onFileChecked callback fires for every candidate regardless of
	 * whether it's hash-skipped or actually changed. This keeps filesChecked
	 * advancing at full parsing speed.
	 */
	private async _runParsePhase(
		candidates: StatEntry[],
		processedPaths: Set<string>,
		scanWorkspace: string,
		signal: AbortSignal,
		channel: BoundedChannel<EmbedWork>,
		onFileChecked: (fileBlockCount: number) => void,
		errors: Error[],
	): Promise<{ hashSkipped: number }> {
		const parseLimiter = pLimit(PARSING_CONCURRENCY)
		let hashSkipped = 0

		// We use a two-layer approach:
		// 1. parseLimiter: reads file, hashes, parses, calls onFileChecked, then RELEASES slot
		// 2. channel.push: happens AFTER parseLimiter releases, so backpressure
		//    doesn't block other parseLimiter slots
		//
		// Fix 1: Process candidates in chunks of PARSE_CHUNK_SIZE instead of
		// creating all promises at once. This prevents the 65K Promise explosion
		// that blocks the event loop and exhausts memory on large workspaces.

		for (let chunkStart = 0; chunkStart < candidates.length; chunkStart += PARSE_CHUNK_SIZE) {
			if (signal.aborted) break

			const chunkEnd = Math.min(chunkStart + PARSE_CHUNK_SIZE, candidates.length)
			const chunk = candidates.slice(chunkStart, chunkEnd)

			const chunkPromises = chunk.map((entry) => {
				// Create an outer promise that wraps parseLimiter + channel.push
				return (async () => {
					if (signal.aborted) return

					// parseLimiter: read → hash → parse → release slot
					const embedWork = await parseLimiter(async () => {
						if (signal.aborted) return null

						try {
							const content = await vscode.workspace.fs
								.readFile(vscode.Uri.file(entry.filePath))
								.then((buffer) => Buffer.from(buffer).toString("utf-8"))

							const currentFileHash = createHash("sha256").update(content).digest("hex")

							const cachedFileHash = this.cacheManager.getHash(entry.normalizedPath)
							const isNewFile = !cachedFileHash

							if (cachedFileHash === currentFileHash) {
								// Hash match — mtime changed but content didn't
								this.cacheManager.updateHash(entry.normalizedPath, currentFileHash, entry.mtimeMs)
								hashSkipped++
								onFileChecked(0)
								return null
							}

							// File is new or changed — parse it
							const blocks = await this.codeParser.parseFile(entry.filePath, {
								content,
								fileHash: currentFileHash,
							})
							this.cacheManager.updateBlockCount(entry.normalizedPath, blocks.length)
							onFileChecked(blocks.length)

							if (blocks.length === 0) {
								// File parsed but produced 0 blocks — just update cache
								this.cacheManager.updateHash(entry.normalizedPath, currentFileHash, entry.mtimeMs)
								return null
							}

							// Return work for the embed phase — parseLimiter slot releases NOW
							return {
								blocks,
								filePath: entry.normalizedPath,
								fileHash: currentFileHash,
								mtimeMs: entry.mtimeMs,
								isNew: isNewFile,
							} as EmbedWork
						} catch (error) {
							if (error instanceof DOMException && error.name === "AbortError") {
								throw error
							}
							const wrappedError =
								error instanceof Error
									? new Error(
											`${error.message} (Workspace: ${scanWorkspace}, File: ${entry.filePath})`,
										)
									: new Error(
											t("embeddings:scanner.unknownErrorProcessingFile", {
												filePath: entry.filePath,
											}) + ` (Workspace: ${scanWorkspace})`,
										)
							errors.push(wrappedError)
							this._errorEmitter.fire(wrappedError)
							console.error(`Error processing file ${entry.filePath}:`, error)
							TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
								error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
								stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
								location: "scanDirectory:processFile",
							})
							onFileChecked(0)
							return null
						}
					})

					// Push to channel OUTSIDE parseLimiter — backpressure blocks HERE,
					// not in the parseLimiter slot. Other files keep parsing.
					if (embedWork && !signal.aborted) {
						await channel.push(embedWork, signal)
					}
				})()
			})

			await Promise.all(chunkPromises)

			// Yield to event loop between chunks — keeps UI responsive on large workspaces
			if (chunkEnd < candidates.length && !signal.aborted) {
				await new Promise((resolve) => setTimeout(resolve, 0))
			}
		}

		return { hashSkipped }
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Phase 3: Embed
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Consumes EmbedWork items from the channel, accumulates into batches,
	 * embeds, and upserts to Qdrant.
	 *
	 * Runs concurrently with Phase 2. The channel provides backpressure:
	 * when the buffer is full, Phase 2's channel.push() blocks (outside
	 * parseLimiter), and when items are consumed here, pushers wake up.
	 */
	private async _runEmbedPhase(
		channel: BoundedChannel<EmbedWork>,
		scanWorkspace: string,
		signal: AbortSignal,
		onBatchComplete: (count: number) => void,
		errors: Error[],
	): Promise<void> {
		if (!this.embedder || !this.qdrantClient) return

		const batchLimiter = pLimit(BATCH_PROCESSING_CONCURRENCY)
		let currentBatchBlocks: CodeBlock[] = []
		let currentBatchTexts: string[] = []
		let currentBatchFileInfos: { filePath: string; fileHash: string; mtimeMs: number; isNew: boolean }[] = []
		const activeBatchPromises = new Set<Promise<void>>()
		let pendingBatchCount = 0

		// Fail-fast tracking
		let consecutiveBatchFailures = 0
		let systemicBatchError: Error | null = null

		const submitBatch = async () => {
			if (currentBatchBlocks.length === 0) return

			// Snapshot and clear accumulators
			const batchBlocks = [...currentBatchBlocks]
			const batchTexts = [...currentBatchTexts]
			const batchFileInfos = [...currentBatchFileInfos]
			currentBatchBlocks = []
			currentBatchTexts = []
			currentBatchFileInfos = []
			pendingBatchCount++

			const batchPromise = batchLimiter(async () => {
				const ok = await this._processBatch(
					batchBlocks,
					batchTexts,
					batchFileInfos,
					scanWorkspace,
					onBatchComplete,
					errors,
				)
				if (ok) {
					consecutiveBatchFailures = 0
				} else {
					consecutiveBatchFailures++
					if (consecutiveBatchFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) {
						systemicBatchError = new Error(
							`Indexing aborted: ${consecutiveBatchFailures} consecutive batch failures — the vector store may be unavailable.`,
						)
					}
				}
			})
			activeBatchPromises.add(batchPromise)
			batchPromise.finally(() => {
				activeBatchPromises.delete(batchPromise)
				pendingBatchCount--
			})
		}

		// Consume items from the channel
		for await (const work of channel.drain(signal)) {
			if (signal.aborted) break
			if (systemicBatchError) break

			// Track file info BEFORE processing blocks — submitBatch() snapshots
			// currentBatchFileInfos, so the current file must already be present.
			currentBatchFileInfos.push({
				filePath: work.filePath,
				fileHash: work.fileHash,
				mtimeMs: work.mtimeMs,
				isNew: work.isNew,
			})

			// Accumulate blocks from this file into current batch
			for (const block of work.blocks) {
				const trimmedContent = block.content.trim()
				if (!trimmedContent) continue

				currentBatchBlocks.push(block)
				currentBatchTexts.push(trimmedContent)

				if (currentBatchBlocks.length >= this.batchSegmentThreshold) {
					// Wait for batch slot if too many pending
					// Fix 3: Yield to event loop between waits to prevent UI freeze
					if (pendingBatchCount >= MAX_PENDING_BATCHES) {
						IndexDebugLogger.log("Scanner", "backpressure-wait", {
							pendingBatches: pendingBatchCount,
							activeBatches: activeBatchPromises.size,
							consecutiveFailures: consecutiveBatchFailures,
						})
					}
					while (pendingBatchCount >= MAX_PENDING_BATCHES) {
						if (signal.aborted || systemicBatchError) break
						// Guard: Promise.race([]) returns a forever-pending promise per JS spec.
						// If activeBatchPromises is unexpectedly empty, break to avoid deadlock.
						if (activeBatchPromises.size === 0) break
						await Promise.race([...activeBatchPromises])
						// Yield to event loop — prevents Extension Host freeze under backpressure
						await new Promise((resolve) => setTimeout(resolve, 0))
					}
					if (signal.aborted || systemicBatchError) break
					await submitBatch()

					// Drain-then-recycle: at recycle boundary, wait for ALL in-flight
					// batches to finish (zero requests on old agents), then destroy
					// and recreate clients. This is the only safe way to call destroy()
					// on undici Agents without killing concurrent requests.
					if (this._batchCount > 0 && this._batchCount % CLIENT_RECYCLE_INTERVAL === 0) {
						await Promise.all([...activeBatchPromises])

						// ── Diagnostic: per-source memory attribution ──
						// Snapshot memory BEFORE recycle, BETWEEN the two recycles
						// (embedder vs qdrant), and AFTER both. This isolates which
						// source accounts for the external memory delta.
						const memBefore = process.memoryUsage()
						const isoStatsBefore = getIsolatedFetchStats()
						const qdrantAgentsBefore = (this.qdrantClient as any).getDispatcherCount?.() ?? -1

						// Phase 1: Recycle embedder (isolated-fetch agents)
						// AWAIT is critical — socket close events must be processed
						// before measuring memory, or V8 external counter won't update.
						await this.embedder.recycleClient?.()
						const memMid = process.memoryUsage()
						const isoStatsMid = getIsolatedFetchStats()

						// Phase 2: Recycle Qdrant (patch agents)
						await this.qdrantClient.recycleClient?.()
						const memAfter = process.memoryUsage()
						const qdrantAgentsAfter = (this.qdrantClient as any).getDispatcherCount?.() ?? -1

						const toMB = (bytes: number) => Math.round(bytes / 1024 / 1024)

						IndexDebugLogger.log("Scanner", "client-recycled", {
							batchNum: this._batchCount,
							// Overall delta
							externalBeforeMB: toMB(memBefore.external),
							externalAfterMB: toMB(memAfter.external),
							externalDeltaMB: toMB(memAfter.external - memBefore.external),
							rssBeforeMB: toMB(memBefore.rss),
							rssAfterMB: toMB(memAfter.rss),
							// Per-source attribution
							embedderExternalDeltaMB: toMB(memMid.external - memBefore.external),
							qdrantExternalDeltaMB: toMB(memAfter.external - memMid.external),
							// Agent lifecycle counters
							isoFetchAlive: isoStatsBefore.alive,
							isoFetchAliveAfter: isoStatsMid.alive,
							isoFetchTotalCreated: isoStatsMid.created,
							isoFetchTotalDestroyed: isoStatsMid.destroyed,
							qdrantAgentsBefore,
							qdrantAgentsAfter,
							phaseTransition: true,
						})
					}
				}
			}
		}

		// Log embed loop exit reason — critical for diagnosing silent hangs
		IndexDebugLogger.log("Scanner", "embed-loop-exit", {
			reason: signal.aborted ? "aborted" : systemicBatchError ? "systemic-error" : "channel-drained",
			pendingBatches: pendingBatchCount,
			activeBatches: activeBatchPromises.size,
			consecutiveFailures: consecutiveBatchFailures,
			remainingBlocks: currentBatchBlocks.length,
		})

		// Flush remaining partial batch
		if (!signal.aborted && !systemicBatchError && currentBatchBlocks.length > 0) {
			await submitBatch()
		}

		// Wait for all batch processing to complete
		IndexDebugLogger.log("Scanner", "embed-drain-start", {
			activeBatches: activeBatchPromises.size,
		})
		await Promise.all(activeBatchPromises)
		IndexDebugLogger.log("Scanner", "embed-drain-done", {
			consecutiveFailures: consecutiveBatchFailures,
			errorCount: errors.length,
		})

		// Propagate systemic error
		if (systemicBatchError) {
			throw systemicBatchError
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Batch Processing
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Process a batch of code blocks: delete old points, embed, upsert.
	 * Returns `true` on success, `false` on failure (after all retries exhausted).
	 */
	private async _processBatch(
		batchBlocks: CodeBlock[],
		batchTexts: string[],
		batchFileInfos: { filePath: string; fileHash: string; mtimeMs: number; isNew: boolean }[],
		scanWorkspace: string,
		onBatchComplete: (count: number) => void,
		errors: Error[],
	): Promise<boolean> {
		if (batchBlocks.length === 0) return true

		this._batchCount++
		const batchNum = this._batchCount

		let attempts = 0
		let success = false
		let lastError: Error | null = null

		while (attempts < MAX_BATCH_RETRIES && !success) {
			attempts++
			try {
				// Wrap the entire attempt in a timeout to prevent indefinite hangs
				// from API/network issues that would otherwise deadlock the pipeline
				await this._withBatchTimeout(async () => {
					// Delete old points for modified files (not new files)
					const uniqueFilePaths = [
						...new Set(batchFileInfos.filter((info) => !info.isNew).map((info) => info.filePath)),
					]
					if (uniqueFilePaths.length > 0) {
						try {
							await this.qdrantClient.deletePointsByMultipleFilePaths(uniqueFilePaths)
						} catch (deleteError: any) {
							const errorMessage =
								deleteError instanceof Error ? deleteError.message : String(deleteError)
							console.error(
								`[DirectoryScanner] Failed to delete points for ${uniqueFilePaths.length} files:`,
								deleteError,
							)
							TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
								error: sanitizeErrorMessage(errorMessage),
								stack:
									deleteError instanceof Error
										? sanitizeErrorMessage(deleteError.stack || "")
										: undefined,
								location: "processBatch:deletePointsByMultipleFilePaths",
								fileCount: uniqueFilePaths.length,
							})
							throw new Error(
								`Failed to delete points for ${uniqueFilePaths.length} files. Workspace: ${scanWorkspace}. ${errorMessage}`,
								{ cause: deleteError },
							)
						}
					}

					// Create embeddings
					const { embeddings } = await this.embedder.createEmbeddings(batchTexts)

					// Prepare and upsert points
					const points = batchBlocks.map((block, index) => {
						const normalizedAbsolutePath = generateNormalizedAbsolutePath(block.file_path, scanWorkspace)
						const pointId = uuidv5(block.segmentHash, QDRANT_CODE_BLOCK_NAMESPACE)
						return {
							id: pointId,
							vector: embeddings[index],
							payload: {
								filePath: generateRelativeFilePath(normalizedAbsolutePath, scanWorkspace),
								codeChunk: block.content,
								startLine: block.start_line,
								endLine: block.end_line,
								segmentHash: block.segmentHash,
							},
						}
					})

					await this.qdrantClient.upsertPoints(points)
				})

				onBatchComplete(batchBlocks.length)

				// Update cache for successfully processed files
				for (const fileInfo of batchFileInfos) {
					this.cacheManager.updateHash(fileInfo.filePath, fileInfo.fileHash, fileInfo.mtimeMs)
				}
				await this.cacheManager.flush()
				success = true

				// Periodic memory snapshot — every 10 batches (and batch 1).
				// Logs externalMB alongside heap so memory trends are visible in debug log.
				if (batchNum === 1 || batchNum % 10 === 0) {
					const mem = process.memoryUsage()
					IndexDebugLogger.log("Scanner", "memory-breakdown", {
						batchNum,
						rssMB: Math.round(mem.rss / 1024 / 1024),
						heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
						heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
						externalMB: Math.round(mem.external / 1024 / 1024),
						arrayBuffersMB: Math.round(mem.arrayBuffers / 1024 / 1024),
						phaseTransition: true,
					})
				}
			} catch (error) {
				lastError = error as Error
				const isTimeout = lastError.message.includes("Batch processing timed out")
				console.error(
					`[DirectoryScanner] Error processing batch (attempt ${attempts}${isTimeout ? ", TIMEOUT" : ""}):`,
					error,
				)
				IndexDebugLogger.log("Scanner", "batch-error", {
					attempt: attempts,
					batchSize: batchBlocks.length,
					isTimeout,
					error: lastError.message,
				})
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
					stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
					location: isTimeout ? "processBatch:timeout" : "processBatch:retry",
					attemptNumber: attempts,
					batchSize: batchBlocks.length,
				})

				if (attempts < MAX_BATCH_RETRIES) {
					const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempts - 1)
					await new Promise((resolve) => setTimeout(resolve, delay))
				}
			}
		}

		if (!success && lastError) {
			console.error(`[DirectoryScanner] Failed to process batch after ${MAX_BATCH_RETRIES} attempts`)
			const wrappedError = new Error(
				t("embeddings:scanner.failedToProcessBatchWithError", {
					maxRetries: MAX_BATCH_RETRIES,
					errorMessage: lastError.message || "Unknown error",
				}),
			)
			errors.push(wrappedError)
			this._errorEmitter.fire(wrappedError)
			return false
		}
		return true
	}

	/**
	 * Wraps a batch processing function with a timeout to prevent indefinite
	 * hangs from API/network issues. If the timeout fires, the batch is
	 * treated as a failure and retried (or counted as a consecutive failure).
	 */
	private async _withBatchTimeout<R>(fn: () => Promise<R>): Promise<R> {
		return new Promise<R>((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				reject(new Error(`Batch processing timed out after ${BATCH_PROCESSING_TIMEOUT_MS}ms`))
			}, BATCH_PROCESSING_TIMEOUT_MS)

			fn().then(
				(result) => {
					clearTimeout(timeoutId)
					resolve(result)
				},
				(error) => {
					clearTimeout(timeoutId)
					reject(error)
				},
			)
		})
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Deleted Files
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Removes Qdrant points for files that are in the cache but no longer
	 * on disk (or no longer pass extension/ignore filters).
	 */
	private async _handleDeletedFiles(
		processedPaths: Set<string>,
		scanWorkspace: string,
		signal: AbortSignal,
		errors: Error[],
	): Promise<void> {
		if (signal.aborted) return

		for (const cachedFilePath of this.cacheManager.cachedFilePaths()) {
			if (signal.aborted) return
			const normalizedCachedPath = path.normalize(cachedFilePath)
			if (!processedPaths.has(normalizedCachedPath)) {
				if (this.qdrantClient) {
					try {
						await this.qdrantClient.deletePointsByFilePath(cachedFilePath)
						await this.cacheManager.deleteHash(cachedFilePath)
					} catch (error: any) {
						const errorMessage = error instanceof Error ? error.message : String(error)
						console.error(`[DirectoryScanner] Failed to delete points for ${cachedFilePath}:`, error)
						TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
							error: sanitizeErrorMessage(errorMessage),
							stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
							location: "scanDirectory:deleteRemovedFiles",
						})
						const wrappedError =
							error instanceof Error
								? new Error(`${error.message} (Workspace: ${scanWorkspace}, File: ${cachedFilePath})`)
								: new Error(
										t("embeddings:scanner.unknownErrorDeletingPoints", {
											filePath: cachedFilePath,
										}) + ` (Workspace: ${scanWorkspace})`,
									)
						errors.push(wrappedError)
						this._errorEmitter.fire(wrappedError)
					}
				}
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Helpers
	// ═══════════════════════════════════════════════════════════════════════

	private _emitProgress(progress: ScanProgress): void {
		this._progressEmitter.fire(progress)
	}

	private _abortedResult(discovery: { totalFiles: number; unchangedCount: number }): ScanResult {
		return {
			totalFiles: discovery.totalFiles,
			processedFiles: 0,
			skippedFiles: discovery.unchangedCount,
			totalBlocks: 0,
			blocksEmbedded: 0,
			errors: [],
		}
	}
}
