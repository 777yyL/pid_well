import { readFile } from "node:fs/promises";
import { evaluateAccuracy, evaluationSchema } from "../shared/evaluation.js";
import { syntheticAccuracyCases } from "../tests/fixtures/accuracy-cases.js";

// pnpm evaluate:accuracy [labeled-predictions.json] ; no database or model calls.
try {
  const input = process.argv[2]
    ? evaluationSchema.parse(
        JSON.parse(await readFile(process.argv[2], "utf8")),
      )
    : syntheticAccuracyCases();
  const result = evaluateAccuracy(input);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (
    (result.policyChecks.denominator &&
      result.policyChecks.numerator !== result.policyChecks.denominator) ||
    input.cases.some(
      (c) =>
        c.expectedLevel &&
        c.predictedLevel &&
        c.expectedLevel !== c.predictedLevel,
    )
  )
    process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "评测输入错误"}\n`,
  );
  process.exitCode = 1;
}
