#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type DatasetName = "dev-open" | "private-mixed";

type DatasetItem = {
  id: string;
  choices: string[];
};

type ItemsPayload = {
  dataset: string;
  items: DatasetItem[];
};

type AnswerKey = {
  dataset: string;
  answers: Record<string, { answer: string }>;
};

type Prediction = {
  id: string;
  answer?: string;
  raw?: string;
  confidence?: number | null;
  error?: string;
  duration_ms?: number;
  model?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };
};

type ScoredPrediction = Prediction & {
  expected_answer?: string;
  parsed_answer?: string;
  correct: boolean;
  parse_error?: string;
};

type ScoreReport = {
  dataset: DatasetName;
  predictions_path: string;
  item_count: number;
  prediction_count: number;
  correct: number;
  incorrect: number;
  errors: number;
  missing_predictions: string[];
  accuracy: number;
  timing: {
    totalDurationMs: number;
    averageDurationMs: number;
  };
  usage: {
    reportedCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
  scored: ScoredPrediction[];
};

type ScoreOptions = {
  dataset: DatasetName;
  predictionsPath: string;
  outputPath?: string;
};

function usage(): string {
  return `Usage: bun run score -- --dataset private-mixed --predictions results/run/predictions.jsonl [--out results/run/score.json]`;
}

function parseDataset(value: string): DatasetName {
  if (value === "dev-open" || value === "private-mixed") return value;
  throw new Error(`Unknown dataset "${value}". Expected dev-open or private-mixed.`);
}

function defaultDataset(): DatasetName {
  return existsSync(resolve(ROOT, "dataset/private-mixed/answer_key.json"))
    ? "private-mixed"
    : "dev-open";
}

function parseArgs(): ScoreOptions {
  const args = process.argv.slice(2);
  const options: Partial<ScoreOptions> = { dataset: defaultDataset() };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--dataset") {
      options.dataset = parseDataset(args[++index] ?? "");
    } else if (arg === "--predictions") {
      options.predictionsPath = resolve(args[++index] ?? "");
    } else if (arg === "--out") {
      options.outputPath = resolve(args[++index] ?? "");
    } else {
      throw new Error(`Unknown argument "${arg}".\n${usage()}`);
    }
  }

  if (!options.predictionsPath) {
    throw new Error(`Missing --predictions.\n${usage()}`);
  }

  return options as ScoreOptions;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function extractLetter(value: string): string | undefined {
  const trimmed = value.trim();
  const exact = trimmed.match(/^[A-H]$/i);
  if (exact) return exact[0].toUpperCase();

  const jsonLike = trimmed.match(/"answer"\s*:\s*"([A-H])"/i);
  if (jsonLike) return jsonLike[1].toUpperCase();

  const labeled = trimmed.match(/\banswer\s*(?:is|:)?\s*([A-H])\b/i);
  if (labeled) return labeled[1].toUpperCase();

  return undefined;
}

function parseAnswer(prediction: Prediction, item: DatasetItem): string | undefined {
  const candidate = prediction.answer ?? prediction.raw ?? "";
  const letter = extractLetter(candidate);
  if (letter) {
    const index = letter.charCodeAt(0) - "A".charCodeAt(0);
    return item.choices[index];
  }

  const normalizedCandidate = normalize(candidate);
  return item.choices.find((choice) => {
    const normalizedChoice = normalize(choice);
    return (
      normalizedCandidate === normalizedChoice ||
      normalizedCandidate.includes(normalizedChoice)
    );
  });
}

function readPredictionsJsonl(raw: string): Prediction[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Prediction;
      } catch (error) {
        throw new Error(`Invalid JSONL at line ${index + 1}: ${(error as Error).message}`);
      }
    });
}

async function scorePredictions(options: ScoreOptions): Promise<ScoreReport> {
  const datasetDir = resolve(ROOT, "dataset", options.dataset);
  const items = await readJson<ItemsPayload>(resolve(datasetDir, "items.json"));
  const answerKey = await readJson<AnswerKey>(resolve(datasetDir, "answer_key.json"));
  const predictions = readPredictionsJsonl(await readFile(options.predictionsPath, "utf8"));

  const itemById = new Map(items.items.map((item) => [item.id, item]));
  const predictionById = new Map(predictions.map((prediction) => [prediction.id, prediction]));
  const scored: ScoredPrediction[] = [];

  for (const prediction of predictions) {
    const item = itemById.get(prediction.id);
    const expected = answerKey.answers[prediction.id]?.answer;
    if (!item || !expected) {
      scored.push({
        ...prediction,
        correct: false,
        parse_error: "unknown item id",
      });
      continue;
    }

    const parsed = prediction.error ? undefined : parseAnswer(prediction, item);
    scored.push({
      ...prediction,
      expected_answer: expected,
      parsed_answer: parsed,
      correct: parsed !== undefined && normalize(parsed) === normalize(expected),
      parse_error: parsed === undefined && !prediction.error ? "could not parse answer" : undefined,
    });
  }

  const missingPredictions = items.items
    .filter((item) => !predictionById.has(item.id))
    .map((item) => item.id);
  const errors = scored.filter((entry) => Boolean(entry.error || entry.parse_error)).length;
  const correct = scored.filter((entry) => entry.correct).length;
  const incorrect = scored.length - correct;
  const totalDurationMs = scored.reduce((sum, entry) => sum + (entry.duration_ms ?? 0), 0);
  const usage = scored.reduce(
    (acc, entry) => {
      if (!entry.usage) return acc;
      acc.reportedCount += 1;
      acc.inputTokens += entry.usage.inputTokens ?? 0;
      acc.outputTokens += entry.usage.outputTokens ?? 0;
      acc.cacheReadTokens += entry.usage.cacheReadTokens ?? 0;
      acc.cacheWriteTokens += entry.usage.cacheWriteTokens ?? 0;
      acc.reasoningTokens += entry.usage.reasoningTokens ?? 0;
      acc.totalTokens +=
        entry.usage.totalTokens ??
        (entry.usage.inputTokens ?? 0) +
          (entry.usage.outputTokens ?? 0) +
          (entry.usage.cacheReadTokens ?? 0) +
          (entry.usage.cacheWriteTokens ?? 0);
      return acc;
    },
    {
      reportedCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
  );

  return {
    dataset: options.dataset,
    predictions_path: options.predictionsPath,
    item_count: items.items.length,
    prediction_count: predictions.length,
    correct,
    incorrect,
    errors,
    missing_predictions: missingPredictions,
    accuracy: scored.length > 0 ? correct / scored.length : 0,
    timing: {
      totalDurationMs,
      averageDurationMs: scored.length > 0 ? totalDurationMs / scored.length : 0,
    },
    usage,
    scored,
  };
}

const options = parseArgs();
const report = await scorePredictions(options);
if (options.outputPath) {
  await writeJson(options.outputPath, report);
}
console.log(JSON.stringify(report, null, 2));
