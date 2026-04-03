export interface ICacheManager {
	getHash(filePath: string): string | undefined
	updateHash(filePath: string, hash: string): void
	deleteHash(filePath: string): void
	flush(): Promise<void>
	getAllHashes(): Record<string, string>
	/** O(1) count of cached files — avoids allocating Object.keys() arrays. */
	get hashCount(): number
	/** Zero-copy iterator over cached file paths. */
	cachedFilePaths(): Iterable<string>
}
