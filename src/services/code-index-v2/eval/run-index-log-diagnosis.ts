import { analyzeIndexingRunFromDebugLog, formatIndexingRunDiagnosis } from "./IndexingRunDiagnosis"

async function main() {
	const logPath = process.argv[2] ?? `${process.env.HOME}/roo-code-index-v2.log`
	const workspacePath = process.argv[3]
	const runId = process.argv[4]

	const diagnosis = await analyzeIndexingRunFromDebugLog({
		logPath,
		workspacePath,
		runId,
	})

	console.log(formatIndexingRunDiagnosis(diagnosis))
}

void main()
