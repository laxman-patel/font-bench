#!/usr/bin/env node

import { Agent } from "@cursor/sdk";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type DatasetItem = {
  id: string;
  image: string;
  choices: string[];
};

type ItemsPayload = {
  dataset: string;
  items: DatasetItem[];
};

type InferenceOptions = {
  itemsPath: string;
  outputPath: string;
  model: string;
  limit?: number;
};

type Prediction = {
  id: string;
  answer?: string;
  raw?: string;
  confidence?: number | null;
  error?: string;
  duration_ms?: number;
  model: string;
};

const CWD = dirname(fileURLToPath(import.meta.url));

function usage(): string {
  return `Usage: npx tsx e2b-infer.ts --items items.json --out predictions.jsonl [--model composer-2.5] [--limit N]`;
}

function parseArgs(): InferenceOptions {
  const args = process.argv.slice(2);
  const options: Partial<InferenceOptions> = {
    itemsPath: resolve(CWD, "items.json"),
    outputPath: resolve(CWD, "predictions.jsonl"),
    model: process.env.CURSOR_MODEL ?? "composer-2.5",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--items") {
      options.itemsPath = resolve(args[++index] ?? "");
    } else if (arg === "--out") {
      options.outputPath = resolve(args[++index] ?? "");
    } else if (arg === "--model") {
      options.model = args[++index] ?? "";
    } else if (arg === "--limit") {
      const limit = Number(args[++index]);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = limit;
    } else {
      throw new Error(`Unknown argument "${arg}".\n${usage()}`);
    }
  }

  if (!options.itemsPath || !options.outputPath || !options.model) {
    throw new Error(usage());
  }
  if (!process.env.CURSOR_API_KEY) {
    throw new Error("CURSOR_API_KEY is required in the E2B sandbox environment.");
  }

  return options as InferenceOptions;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function letterForIndex(index: number): string {
  return String.fromCharCode("A".charCodeAt(0) + index);
}

function buildPrompt(item: DatasetItem): string {
  const choices = item.choices
    .map((choice, index) => `${letterForIndex(index)}. ${choice}`)
    .join("\n");

  return `You are evaluating a font-identification benchmark.

Look only at the supplied image. Choose which listed font family was used to render the text.

Rules:
- Do not use tools.
- Do not inspect files other than the supplied image content.
- Return exactly one JSON object and nothing else.
- The JSON schema is: {"answer":"A","confidence":0.0}
- "answer" must be one of the listed letters.
- "confidence" must be a number from 0 to 1.

Choices:
${choices}`;
}

function parseModelJson(raw: string): { answer?: string; confidence?: number | null } {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const candidate = fenced ?? trimmed;

  try {
    const parsed = JSON.parse(candidate) as { answer?: unknown; confidence?: unknown };
    return {
      answer: typeof parsed.answer === "string" ? parsed.answer.trim().toUpperCase() : undefined,
      confidence:
        typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
          ? parsed.confidence
          : null,
    };
  } catch {
    const letter = candidate.match(/\b([A-H])\b/i)?.[1];
    return {
      answer: letter?.toUpperCase(),
      confidence: null,
    };
  }
}

async function disposeAgent(agent: unknown): Promise<void> {
  const disposable = agent as { [Symbol.asyncDispose]?: () => Promise<void>; close?: () => void };
  const asyncDispose = disposable[Symbol.asyncDispose];
  if (asyncDispose) {
    await asyncDispose.call(disposable);
  } else {
    disposable.close?.();
  }
}

async function inferItem(item: DatasetItem, model: string): Promise<Prediction> {
  const startedAt = Date.now();
  let agent: Awaited<ReturnType<typeof Agent.create>> | undefined;

  try {
    const imagePath = resolve(CWD, item.image);
    const image = await readFile(imagePath);
    agent = await Agent.create({
      apiKey: process.env.CURSOR_API_KEY,
      model: { id: model },
      local: {
        cwd: CWD,
        settingSources: [],
        sandboxOptions: { enabled: true },
      },
    });

    const run = await agent.send({
      text: buildPrompt(item),
      images: [{ data: image.toString("base64"), mimeType: "image/png" }],
    });
    const result = await run.wait();
    const raw = result.result ?? "";
    const parsed = parseModelJson(raw);

    return {
      id: item.id,
      answer: parsed.answer,
      raw,
      confidence: parsed.confidence,
      duration_ms: result.durationMs ?? Date.now() - startedAt,
      model: result.model?.id ?? model,
      error: result.status === "finished" ? undefined : `run status: ${result.status}`,
    };
  } catch (error) {
    return {
      id: item.id,
      error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - startedAt,
      model,
    };
  } finally {
    if (agent) await disposeAgent(agent);
  }
}

async function main(): Promise<void> {
  const options = parseArgs();
  const payload = await readJson<ItemsPayload>(options.itemsPath);
  const items = options.limit ? payload.items.slice(0, options.limit) : payload.items;
  const predictions: Prediction[] = [];

  for (const item of items) {
    const prediction = await inferItem(item, options.model);
    predictions.push(prediction);
    await writeFile(
      options.outputPath,
      `${predictions.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    console.log(JSON.stringify(prediction));
  }
}

await main();
