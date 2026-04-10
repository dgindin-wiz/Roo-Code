import { buildIndexingTelemetryReport, resolveDefaultTelemetryLogPath } from "./IndexingTelemetryReport"
import { formatIndexingTelemetryReport } from "./format-indexing-telemetry-report"

async function main() {
	const dbPath = process.argv[2]
	if (!dbPath) {
		throw new Error("Usage: run-index-telemetry-report <dbPath> [runId] [logPath]")
	}
	const runId = process.argv[3]
	const logPath = process.argv[4] ?? resolveDefaultTelemetryLogPath(dbPath)
	const report = await buildIndexingTelemetryReport({
		dbPath,
		runId,
		logPath,
	})
	console.log(formatIndexingTelemetryReport(report))
}

void main()
