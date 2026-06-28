#!/usr/bin/env bun

import { Sandbox } from "e2b";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE_RUN_DIR = "/home/user/font-bench-run";
const RESULTS_DIR = resolve(ROOT, "results/e2b");

type DatasetName = "dev-open" | "private-mixed";

type RunOptions = {
  dataset: DatasetName;
  limit?: number;
  itemIds: string[];
  model: string;
  template?: string;
  keepSandbox: boolean;
  commandTimeoutMs: number;
};

type PreparedMetadata = {
  dataset: DatasetName;
  workspace: string;
  item_count: number;
};

type ScoreReport = {
  dataset: DatasetName;
  prediction_count: number;
  correct: number;
  incorrect: number;
  errors: number;
  accuracy: number;
};

function usage(): string {
  return `Usage: bun run e2b:eval -- [--dataset private-mixed] [--limit N] [--item sample_00000] [--model composer-2.5] [--template TEMPLATE] [--keep-sandbox]

Requires:
- E2B_API_KEY in the local environment
- CURSOR_API_KEY in the local environment; passed into E2B only for the inference process

The controller uploads only a sanitized inference workspace. It scores locally against answer_key.json after downloading predictions.jsonl.`;
}

function defaultDataset(): DatasetName {
  return existsSync(resolve(ROOT, "dataset/private-mixed/items.json"))
    ? "private-mixed"
    : "dev-open";
}

function parseDataset(value: string): DatasetName {
  if (value === "dev-open" || value === "private-mixed") return value;
  throw new Error(`Unknown dataset "${value}". Expected dev-open or private-mixed.`);
}

function parseArgs(): RunOptions {
  const args = process.argv.slice(2);
  const options: RunOptions = {
    dataset: defaultDataset(),
    itemIds: [],
    model: process.env.CURSOR_MODEL ?? "composer-2.5",
    keepSandbox: false,
    commandTimeoutMs: 20 * 60 * 1000,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--dataset") {
      options.dataset = parseDataset(args[++index] ?? "");
    } else if (arg === "--limit") {
      const limit = Number(args[++index]);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = limit;
    } else if (arg === "--item") {
      const itemId = args[++index];
      if (!itemId) throw new Error("--item requires a sample id");
      options.itemIds.push(itemId);
    } else if (arg === "--model") {
      options.model = args[++index] ?? "";
    } else if (arg === "--template") {
      options.template = args[++index] ?? "";
    } else if (arg === "--keep-sandbox") {
      options.keepSandbox = true;
    } else if (arg === "--timeout-ms") {
      const timeout = Number(args[++index]);
      if (!Number.isInteger(timeout) || timeout <= 0) {
        throw new Error("--timeout-ms must be a positive integer");
      }
      options.commandTimeoutMs = timeout;
    } else {
      throw new Error(`Unknown argument "${arg}".\n${usage()}`);
    }
  }

  if (!options.model) throw new Error("--model cannot be empty");
  if (!process.env.E2B_API_KEY) throw new Error("E2B_API_KEY is required.");
  if (!process.env.CURSOR_API_KEY) throw new Error("CURSOR_API_KEY is required.");
  return options;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runLocalCommand(command: string[], cwd = ROOT): Promise<string> {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Command failed (${command.join(" ")}):\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }
  return stdout;
}

async function prepareWorkspace(options: RunOptions): Promise<PreparedMetadata> {
  const args = [
    "bun",
    "run",
    "scripts/prepare-inference-workspace.ts",
    "--dataset",
    options.dataset,
  ];
  if (options.limit !== undefined) args.push("--limit", String(options.limit));
  for (const itemId of options.itemIds) args.push("--item", itemId);

  const stdout = await runLocalCommand(args);
  const metadata = JSON.parse(stdout) as PreparedMetadata;
  if (!isInside(tmpdir(), metadata.workspace)) {
    throw new Error(`Prepared workspace is not under tmpdir: ${metadata.workspace}`);
  }
  return metadata;
}

async function listFilesRecursive(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = resolve(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(fullPath)));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function remotePathFor(localWorkspace: string, localPath: string): string {
  const rel = relative(localWorkspace, localPath).split("\\").join("/");
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`Refusing to upload path outside prepared workspace: ${localPath}`);
  }
  return `${REMOTE_RUN_DIR}/${rel}`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

async function uploadPreparedWorkspace(sandbox: Sandbox, workspace: string): Promise<void> {
  await sandbox.commands.run(`mkdir -p ${shellQuote(REMOTE_RUN_DIR)}`);
  const files = await listFilesRecursive(workspace);
  for (const file of files) {
    const bytes = await readFile(file);
    await sandbox.files.write(remotePathFor(workspace, file), toArrayBuffer(bytes));
  }
}

async function uploadSandboxRunner(sandbox: Sandbox): Promise<void> {
  const runnerSource = await readFile(resolve(ROOT, "scripts/e2b-infer.ts"), "utf8");
  const packageJson = {
    type: "module",
    dependencies: {
      "@cursor/sdk": "^1.0.22",
      tsx: "^4.21.0",
    },
  };

  await sandbox.files.write(`${REMOTE_RUN_DIR}/e2b-infer.ts`, runnerSource);
  await sandbox.files.write(
    `${REMOTE_RUN_DIR}/package.json`,
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
}

async function runSandboxInference(
  sandbox: Sandbox,
  options: RunOptions,
): Promise<{ stdout: string; stderr: string }> {
  const limitArg = options.limit !== undefined ? ` --limit ${options.limit}` : "";
  const command = [
    "set -euo pipefail",
    "node --version",
    "npm install --silent",
    `npx tsx e2b-infer.ts --items items.json --out predictions.jsonl --model ${shellQuote(
      options.model,
    )}${limitArg}`,
  ].join(" && ");

  const result = await sandbox.commands.run(command, {
    cwd: REMOTE_RUN_DIR,
    timeoutMs: options.commandTimeoutMs,
    envs: {
      CURSOR_API_KEY: process.env.CURSOR_API_KEY!,
      CURSOR_MODEL: options.model,
    },
  });

  return { stdout: result.stdout, stderr: result.stderr };
}

async function writeRunArtifacts(input: {
  options: RunOptions;
  prepared: PreparedMetadata;
  predictions: string;
  sandboxStdout: string;
  sandboxStderr: string;
}): Promise<{ runDir: string; predictionsPath: string; scorePath: string }> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = resolve(RESULTS_DIR, `${input.options.dataset}-${runId}`);
  await mkdir(runDir, { recursive: true });

  const predictionsPath = resolve(runDir, "predictions.jsonl");
  const scorePath = resolve(runDir, "score.json");
  await writeFile(predictionsPath, input.predictions, "utf8");
  await writeFile(resolve(runDir, "sandbox.stdout.log"), input.sandboxStdout, "utf8");
  await writeFile(resolve(runDir, "sandbox.stderr.log"), input.sandboxStderr, "utf8");
  await writeFile(
    resolve(runDir, "run_metadata.json"),
    `${JSON.stringify(
      {
        dataset: input.options.dataset,
        model: input.options.model,
        item_count: input.prepared.item_count,
        prepared_workspace: input.prepared.workspace,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { runDir, predictionsPath, scorePath };
}

async function scoreLocally(input: {
  dataset: DatasetName;
  predictionsPath: string;
  scorePath: string;
}): Promise<ScoreReport> {
  const stdout = await runLocalCommand([
    "bun",
    "run",
    "scripts/score-predictions.ts",
    "--dataset",
    input.dataset,
    "--predictions",
    input.predictionsPath,
    "--out",
    input.scorePath,
  ]);
  return JSON.parse(stdout) as ScoreReport;
}

async function createSandbox(options: RunOptions): Promise<Sandbox> {
  const sandboxOptions = {
    timeoutMs: Math.max(options.commandTimeoutMs + 5 * 60 * 1000, 30 * 60 * 1000),
  };
  if (options.template) {
    return Sandbox.create(options.template, sandboxOptions);
  }
  return Sandbox.create(sandboxOptions);
}

async function main(): Promise<void> {
  const options = parseArgs();
  const prepared = await prepareWorkspace(options);
  const sandbox = await createSandbox(options);

  try {
    await uploadPreparedWorkspace(sandbox, prepared.workspace);
    await uploadSandboxRunner(sandbox);
    const { stdout, stderr } = await runSandboxInference(sandbox, options);
    const predictions = await sandbox.files.read(`${REMOTE_RUN_DIR}/predictions.jsonl`);
    const artifacts = await writeRunArtifacts({
      options,
      prepared,
      predictions,
      sandboxStdout: stdout,
      sandboxStderr: stderr,
    });
    const score = await scoreLocally({
      dataset: options.dataset,
      predictionsPath: artifacts.predictionsPath,
      scorePath: artifacts.scorePath,
    });

    console.log(
      JSON.stringify(
        {
          run_dir: artifacts.runDir,
          predictions_path: artifacts.predictionsPath,
          score_path: artifacts.scorePath,
          dataset: score.dataset,
          prediction_count: score.prediction_count,
          correct: score.correct,
          incorrect: score.incorrect,
          errors: score.errors,
          accuracy: score.accuracy,
        },
        null,
        2,
      ),
    );
  } finally {
    if (options.keepSandbox) {
      console.error(`Keeping sandbox running: ${sandbox.sandboxId}`);
    } else {
      await sandbox.kill();
    }
  }
}

await main();
