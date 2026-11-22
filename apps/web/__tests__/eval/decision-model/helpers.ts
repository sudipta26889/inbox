import * as fs from "node:fs";
import * as path from "node:path";
import { expect } from "vitest";
import {
  EVAL_MODEL_CATALOG,
  getEmailAccountForModel,
} from "@/__tests__/eval/model-catalog";
import { shouldRunEvalTests, getEvalTimeout } from "@/__tests__/eval/models";
import type { createEvalReporter } from "@/__tests__/eval/reporter";
import { env } from "@/env";
import {
  createDecisionModelConfig,
  DecisionUncertainError,
  type DecisionModelResponse,
} from "@/utils/decision-model/decision-model";
import { createScopedLogger } from "@/utils/logger";

const evalDecisionModelConfig = createDecisionModelConfig(
  env.DEFAULT_DECISION_MODEL ?? "litellm:local/decision",
);
export const shouldRunDecisionModelEvals =
  shouldRunEvalTests() && !!evalDecisionModelConfig;
// The cloud comparison model only runs when a key is configured.
const shouldCompareWithLuna = !!env.OPENROUTER_API_KEY;
export const DECISION_MODEL_EVAL_TIMEOUT = getEvalTimeout(60_000);
export const decisionModelEvalLogger = createScopedLogger(
  "eval-decision-model-comparison",
);
export const lunaEmailAccount = getEmailAccountForModel(
  EVAL_MODEL_CATALOG["gpt-6-luna"],
);
// Answers of the decision model call(s) since the last case was recorded.
let capturedResponses: DecisionModelResponse[] = [];
// Only read when shouldRunDecisionModelEvals is true.
export const decisionModelConfig = {
  ...evalDecisionModelConfig!,
  onResult: (response: DecisionModelResponse) => {
    capturedResponses.push(response);
  },
};

const CALIBRATION_FILE = path.join(
  process.cwd(),
  "__tests__",
  "eval",
  ".results",
  "decision-calibration.jsonl",
);

export async function compareDecision<T>({
  testName,
  expected,
  runJev,
  runLuna,
  reporter,
}: {
  testName: string;
  expected: T;
  runJev: () => Promise<T>;
  runLuna: () => Promise<T>;
  reporter: ReturnType<typeof createEvalReporter>;
}) {
  capturedResponses = [];
  const lunaRun = shouldCompareWithLuna ? runLuna() : undefined;
  let jev: T;
  try {
    jev = await runJev();
  } catch (error) {
    recordCalibration({
      testName,
      expected,
      error: error instanceof Error ? error.message : String(error),
    });
    await lunaRun?.catch(() => undefined);
    throw error;
  }
  recordCalibration({ testName, expected, actual: jev });
  const luna = lunaRun ? await lunaRun : undefined;

  recordResult({
    reporter,
    testName,
    model: decisionModelConfig.modelId,
    actual: jev,
    expected,
  });
  if (lunaRun) {
    recordResult({
      reporter,
      testName,
      model: "GPT-6 Luna",
      actual: luna,
      expected,
    });
  }

  expect(jev).toEqual(expected);
  if (lunaRun) expect(luna).toEqual(expected);
}

/** For cases that call the decision model directly instead of compareDecision. */
export function recordDecisionCase<T>({
  testName,
  expected,
  actual,
}: {
  testName: string;
  expected: T;
  actual: T;
}) {
  recordCalibration({ testName, expected, actual });
}

/**
 * Calibration case where "the model was not sure" is an outcome to record, not
 * a failure: the test fails only on a confidently wrong answer or a real error.
 */
export async function runCalibrationCase<T>({
  testName,
  expected,
  run,
}: {
  testName: string;
  expected: T;
  run: () => Promise<T>;
}) {
  capturedResponses = [];
  let actual: T;
  try {
    actual = await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isUncertain(error)) {
      recordCalibration({
        testName,
        expected,
        error: message,
        outcome: "uncertain",
      });
      return;
    }
    recordCalibration({ testName, expected, error: message });
    throw error;
  }
  recordCalibration({ testName, expected, actual });
  expect(actual).toEqual(expected);
}

// choose-rule throws a plain Error below its minimum confidence.
function isUncertain(error: unknown) {
  return (
    error instanceof DecisionUncertainError ||
    (error instanceof Error &&
      error.message.startsWith("Decision model confidence is too low"))
  );
}

function recordCalibration<T>({
  testName,
  expected,
  actual,
  error,
  outcome,
}: {
  testName: string;
  expected: T;
  actual?: T;
  error?: string;
  outcome?: "uncertain";
}) {
  const answers = capturedResponses.map((response) => ({
    model: response.model,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    questions: Object.fromEntries(
      Object.entries(response.answers).map(([key, answer]) => [
        key,
        summarizeAnswer(answer),
      ]),
    ),
  }));
  capturedResponses = [];

  const line = {
    suite: path.basename(expect.getState().testPath ?? "unknown"),
    testName,
    model: decisionModelConfig.modelId,
    expected,
    actual: error ? undefined : actual,
    outcome: outcome ?? (error ? "error" : "decided"),
    pass: error ? false : formatValue(actual) === formatValue(expected),
    error,
    answers,
  };
  fs.mkdirSync(path.dirname(CALIBRATION_FILE), { recursive: true });
  fs.appendFileSync(CALIBRATION_FILE, `${JSON.stringify(line)}\n`);
}

function summarizeAnswer(answer: DecisionModelResponse["answers"][string]) {
  if (!answer) return null;
  if (answer.type === "boolean") return { probability: answer.probability };

  const ranked = Object.entries(answer.probabilities).sort(
    ([, a], [, b]) => b - a,
  );
  const top = ranked[0]?.[1] ?? null;
  const second = ranked[1]?.[1];
  return {
    choice: answer.choice,
    confidence: answer.confidence,
    topProbability: top,
    margin: top === null ? null : top - (second ?? 0),
    probabilities: Object.fromEntries(ranked),
  };
}

function recordResult<T>({
  reporter,
  testName,
  model,
  actual,
  expected,
}: {
  reporter: ReturnType<typeof createEvalReporter>;
  testName: string;
  model: string;
  actual: T;
  expected: T;
}) {
  const actualText = formatValue(actual);
  const expectedText = formatValue(expected);
  reporter.record({
    testName,
    model,
    pass: actualText === expectedText,
    expected: expectedText,
    actual: actualText,
  });
}

function formatValue(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}
