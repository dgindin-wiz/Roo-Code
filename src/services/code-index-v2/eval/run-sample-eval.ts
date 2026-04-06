import { sampleCodeIndexEvalFixtures } from "./fixtures/sample-fixtures"
import { RetrievalEvaluator } from "./RetrievalEvaluator"
import { formatRetrievalEvalReport } from "./format-report"

async function main() {
	const evaluator = new RetrievalEvaluator([1, 3, 5])

	// Placeholder retriever hook.
	// Wire this to a local CodeIndexEngineV2 instance or another retrieval adapter
	// when running the evaluator against a real workspace index.
	const report = await evaluator.evaluate(sampleCodeIndexEvalFixtures, async () => [])

	console.log(formatRetrievalEvalReport(report))
}

void main()
