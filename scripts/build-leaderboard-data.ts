#!/usr/bin/env bun

/**
 * Aggregates the model-comparison E2B runs into the static leaderboard data
 * file consumed by the Astro site. Reads from the gitignored results/ artifacts
 * and writes a committed JSON snapshot.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(ROOT, "site/src/data/benchmark-results.json");

const COMPARISON_DIRS = ["comparison-20", "comparison-20-v2", "comparison-20-v3"] as const;

const MODELS = [
  {
    label: "composer-2.5-fast",
    id: "composer-2.5:fast",
    display: "composer-2.5",
    config: "fast",
    vendor: "cursor",
  },
  {
    label: "gpt-5.5-extra-high",
    id: "gpt-5.5",
    display: "gpt-5.5",
    config: "reasoning: extra-high",
    vendor: "openai",
  },
  {
    label: "opus-4.8-extra-high",
    id: "claude-opus-4-8",
    display: "claude-opus-4.8",
    config: "thinking, effort: xhigh",
    vendor: "anthropic",
  },
  {
    label: "gemini-3.1-pro",
    id: "gemini-3.1-pro",
    display: "gemini-3.1-pro",
    config: "default",
    vendor: "google",
  },
] as const;

type ScoreFile = {
  correct: number;
  prediction_count: number;
  errors: number;
  accuracy: number;
  timing: { totalDurationMs: number; averageDurationMs: number };
  usage: { totalTokens: number; reasoningTokens: number; reportedCount: number };
};

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function scorePathFromLog(dir: string, label: string): Promise<string | undefined> {
  const logPath = resolve(ROOT, "results/e2b", dir, `${label}.log`);
  if (!existsSync(logPath)) return undefined;
  const log = await readFile(logPath, "utf8");
  const objects = [...log.matchAll(/\{[\s\S]*?\n\}/g)];
  if (objects.length === 0) return undefined;
  const last = JSON.parse(objects[objects.length - 1][0]) as { score_path?: string };
  return last.score_path;
}

async function main(): Promise<void> {
  const models = [];

  for (const model of MODELS) {
    const perRun: { seed: number; correct: number; total: number; accuracy: number }[] = [];
    let correct = 0;
    let total = 0;
    let errors = 0;
    let totalTokens = 0;
    let reasoningTokens = 0;
    let totalDurationMs = 0;

    for (let i = 0; i < COMPARISON_DIRS.length; i += 1) {
      const scorePath = await scorePathFromLog(COMPARISON_DIRS[i], model.label);
      if (!scorePath || !existsSync(scorePath)) continue;
      const score = await readJson<ScoreFile>(scorePath);
      perRun.push({
        seed: i + 1,
        correct: score.correct,
        total: score.prediction_count,
        accuracy: score.accuracy,
      });
      correct += score.correct;
      total += score.prediction_count;
      errors += score.errors;
      totalTokens += score.usage.totalTokens;
      reasoningTokens += score.usage.reasoningTokens;
      totalDurationMs += score.timing.totalDurationMs;
    }

    models.push({
      id: model.id,
      display: model.display,
      vendor: model.vendor,
      config: model.config,
      samples: total,
      correct,
      errors,
      accuracy: total > 0 ? correct / total : 0,
      totalTokens,
      reasoningTokens,
      avgTokensPerItem: total > 0 ? Math.round(totalTokens / total) : 0,
      totalDurationMs,
      avgDurationMs: total > 0 ? Math.round(totalDurationMs / total) : 0,
      perRun,
      excluded: false,
    });
  }

  models.sort((a, b) => b.accuracy - a.accuracy);

  const data = {
    benchmark: "fontbench",
    version: "v1",
    generatedAt: new Date().toISOString(),
    dataset: {
      name: "private-mixed",
      totalSamples: 126,
      evaluatedSamples: models[0]?.samples ?? 0,
      seeds: COMPARISON_DIRS.length,
      fonts: 21,
      openFonts: 15,
      proprietaryFonts: 6,
      choices: 4,
      chance: 0.25,
    },
    excludedModels: [
      {
        id: "glm-5.2",
        display: "glm-5.2",
        config: "reasoning: max",
        vendor: "zhipu",
        reason: "No image input support through the Cursor SDK route (text-only); evaluation hung and was excluded.",
      },
    ],
    models,
  };

  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Wrote ${OUTPUT}`);
  console.log(
    models
      .map((m) => `${m.display}: ${m.correct}/${m.samples} = ${(m.accuracy * 100).toFixed(1)}%`)
      .join("\n"),
  );
}

await main();
