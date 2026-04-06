import { ICodeIndexEngine } from "../engine/interfaces"
import { RetrievalEvaluator } from "./RetrievalEvaluator"
import { RetrievalEvalFixture, RetrievalEvalReport } from "./types"

export class CodeIndexEvalRunner {
	constructor(
		private readonly engine: ICodeIndexEngine,
		private readonly options: {
			limit?: number
			kValues?: number[]
		} = {},
	) {}

	async run(fixtures: RetrievalEvalFixture[]): Promise<RetrievalEvalReport> {
		const limit = this.options.limit ?? 5
		const evaluator = new RetrievalEvaluator(this.options.kValues ?? [1, 3, 5])

		return evaluator.evaluate(fixtures, async (query, requestedLimit) =>
			this.engine.search(query, Math.max(limit, requestedLimit)),
		)
	}
}
