const LOW_VALUE_FILE_NAMES = new Set([
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
	"cargo.lock",
])

const LOW_VALUE_PATH_SEGMENTS = new Set(["__snapshots__"])

export function shouldSkipLowValueFile(relativePath: string): boolean {
	const normalizedPath = relativePath.replace(/\\/g, "/").toLowerCase()
	const fileName = normalizedPath.split("/").pop() || normalizedPath

	if (LOW_VALUE_FILE_NAMES.has(fileName)) {
		return true
	}

	if (normalizedPath.includes("/__snapshots__/")) {
		return true
	}

	if (fileName.endsWith(".snap")) {
		return true
	}

	if (fileName.includes(".min.") && !fileName.endsWith(".min.ts")) {
		return true
	}

	return normalizedPath.split("/").some((segment) => LOW_VALUE_PATH_SEGMENTS.has(segment))
}
