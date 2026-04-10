import * as path from "path"

const bootstrapTag = "[CodeIndexV2ParseSidecarBootstrap]"

try {
	process.stderr.write(`${bootstrapTag} bootstrap-start pid=${process.pid}\n`)
	const workerPath = path.join(__dirname, "codeIndexV2ParseSidecar.js")
	process.stderr.write(`${bootstrapTag} requiring ${workerPath}\n`)
	require(workerPath)
	process.stderr.write(`${bootstrapTag} require-complete pid=${process.pid}\n`)
} catch (error) {
	const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
	process.stderr.write(`${bootstrapTag} bootstrap-error ${message}\n`)
	throw error
}
