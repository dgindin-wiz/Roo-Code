import * as vscode from "vscode"
import { PointStruct } from "./vector-store"

/**
 * Interface for code file parser
 */
export interface ICodeParser {
	/**
	 * Parses a code file into code blocks
	 * @param filePath Path to the file to parse
	 * @param options Optional parsing options
	 * @returns Promise resolving to array of code blocks
	 */
	parseFile(
		filePath: string,
		options?: {
			minBlockLines?: number
			maxBlockLines?: number
			content?: string
			fileHash?: string
		},
	): Promise<CodeBlock[]>
}

/**
 * Progress reported by the scanner during indexing.
 */
export interface ScanProgress {
	phase: "discovering" | "parsing" | "embedding" | "complete"
	filesChecked: number
	totalFiles: number
	blocksEmbedded: number
	totalBlocksEstimate: number
	isEstimatedTotal: boolean
}

/**
 * Result returned when a scan completes.
 */
export interface ScanResult {
	totalFiles: number
	processedFiles: number
	skippedFiles: number
	totalBlocks: number
	blocksEmbedded: number
	errors: Error[]
}

/**
 * Interface for directory scanner
 */
export interface IDirectoryScanner {
	/**
	 * Scans a directory for code files, parses them, and embeds/upserts to the vector store.
	 * Emits progress events via `onProgress` and errors via `onError`.
	 * @param directory Path to the directory to scan
	 * @param signal AbortSignal for cancellation
	 * @returns Promise resolving to scan results
	 */
	scanDirectory(directory: string, signal: AbortSignal): Promise<ScanResult>

	/** Fired whenever scan progress changes. */
	readonly onProgress: vscode.Event<ScanProgress>

	/** Fired for non-fatal errors during scanning. */
	readonly onError: vscode.Event<Error>
}

/**
 * Interface for file watcher
 */
export interface IFileWatcher extends vscode.Disposable {
	/**
	 * Initializes the file watcher
	 */
	initialize(): Promise<void>

	/**
	 * Event emitted when a batch of files begins processing.
	 * The event payload is an array of file paths included in the batch.
	 */
	readonly onDidStartBatchProcessing: vscode.Event<string[]>

	/**
	 * Event emitted to report progress during batch processing.
	 */
	readonly onBatchProgressUpdate: vscode.Event<{
		processedInBatch: number
		totalInBatch: number
		currentFile?: string
	}>

	/**
	 * Event emitted when a batch of files has finished processing.
	 * The event payload contains a summary of the batch operation.
	 */
	readonly onDidFinishBatchProcessing: vscode.Event<BatchProcessingSummary>

	/**
	 * Processes a file
	 * @param filePath Path to the file to process
	 * @returns Promise resolving to processing result
	 */
	processFile(filePath: string): Promise<FileProcessingResult>
}

export interface BatchProcessingSummary {
	/** All files attempted in the batch, including their final status. */
	processedFiles: FileProcessingResult[]
	/** Optional error if the entire batch operation failed (e.g., database connection issue). */
	batchError?: Error
}

export interface FileProcessingResult {
	path: string
	status: "success" | "skipped" | "error" | "processed_for_batching" | "local_error"
	error?: Error
	reason?: string
	newHash?: string
	pointsToUpsert?: PointStruct[]
}

/**
 * Common types used across the code-index service
 */

export interface CodeBlock {
	file_path: string
	identifier: string | null
	parentIdentifier?: string | null
	parentChunkFingerprint?: string | null
	type: string
	start_line: number
	end_line: number
	content: string
	fileHash: string
	segmentHash: string
}
