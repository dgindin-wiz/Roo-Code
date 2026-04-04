import { codeParser } from "../../code-index/processors"
import { ParserAdapter, ParsedChunk } from "./ParserAdapter"

export class CodeIndexParserAdapter implements ParserAdapter {
	readonly parserVersion = "legacy-code-parser-v1"

	async parseFile(input: { filePath: string; content: string }): Promise<ParsedChunk[]> {
		const blocks = await codeParser.parseFile(input.filePath, {
			content: input.content,
		})

		return blocks.map((block) => ({
			chunkFingerprint: block.segmentHash,
			content: block.content,
			startLine: block.start_line,
			endLine: block.end_line,
			language: block.type,
		}))
	}
}
