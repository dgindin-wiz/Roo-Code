import type { CustomModePrompts, ModeConfig } from "@roo-code/types"

vi.mock("vscode")

vi.mock("../../prompts/sections/custom-instructions", () => ({
	addCustomInstructions: vi.fn().mockResolvedValue("Combined instructions"),
}))

import { getAllModesWithPrompts, getFullModeDetails } from "../modeDetails"
import { addCustomInstructions } from "../../prompts/sections/custom-instructions"
import { modes } from "../../../shared/modes"

describe("modeDetails", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(addCustomInstructions).mockResolvedValue("Combined instructions")
	})

	describe("getAllModesWithPrompts", () => {
		it("applies prompt overrides from extension state", async () => {
			const context = {
				globalState: {
					get: vi
						.fn()
						.mockResolvedValueOnce([
							{
								slug: "custom-code",
								name: "Custom Code",
								roleDefinition: "Custom code role",
								customInstructions: "Custom code instructions",
								groups: ["read"],
							} satisfies ModeConfig,
						])
						.mockResolvedValueOnce({
							"custom-code": {
								roleDefinition: "Overridden role",
								customInstructions: "Overridden instructions",
								whenToUse: "Overridden when-to-use",
							},
						} satisfies CustomModePrompts),
				},
			} as any

			const result = await getAllModesWithPrompts(context)

			expect(result).toContainEqual(
				expect.objectContaining({
					slug: "custom-code",
					roleDefinition: "Overridden role",
					customInstructions: "Overridden instructions",
					whenToUse: "Overridden when-to-use",
				}),
			)
		})
	})

	describe("getFullModeDetails", () => {
		it("returns base mode when no overrides exist", async () => {
			const result = await getFullModeDetails("debug")
			expect(result).toMatchObject({
				slug: "debug",
				name: "🪲 Debug",
				roleDefinition:
					"You are Roo, an expert software debugger specializing in systematic problem diagnosis and resolution.",
			})
		})

		it("applies custom mode overrides", async () => {
			const customModes: ModeConfig[] = [
				{
					slug: "debug",
					name: "Custom Debug",
					roleDefinition: "Custom debug role",
					groups: ["read"],
				},
			]

			const result = await getFullModeDetails("debug", customModes)
			expect(result).toMatchObject({
				slug: "debug",
				name: "Custom Debug",
				roleDefinition: "Custom debug role",
				groups: ["read"],
			})
		})

		it("applies prompt component overrides", async () => {
			const customModePrompts = {
				debug: {
					roleDefinition: "Overridden role",
					customInstructions: "Overridden instructions",
				},
			}

			const result = await getFullModeDetails("debug", undefined, customModePrompts)
			expect(result.roleDefinition).toBe("Overridden role")
			expect(result.customInstructions).toBe("Overridden instructions")
		})

		it("combines custom instructions when cwd provided", async () => {
			const options = {
				cwd: "/test/path",
				globalCustomInstructions: "Global instructions",
				language: "en",
			}

			await getFullModeDetails("debug", undefined, undefined, options)

			expect(addCustomInstructions).toHaveBeenCalledWith(
				expect.any(String),
				"Global instructions",
				"/test/path",
				"debug",
				{ language: "en" },
			)
		})

		it("falls back to first mode for non-existent mode", async () => {
			const result = await getFullModeDetails("non-existent")
			expect(result).toMatchObject(modes[0])
		})
	})
})
