#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INFERENCE_TMP_ROOT = resolve(tmpdir(), "font-bench-inference");

type DatasetName = "dev-open" | "private-mixed";

type DatasetItem = {
  id: string;
  image: string;
  track: "mcq";
  choices: string[];
  tier: Record<string, string>;
  determinable: boolean;
  render: Record<string, unknown>;
};

type DatasetPayload = {
  dataset: string;
  items: DatasetItem[];
};

type PrepareOptions = {
  dataset: DatasetName;
  limit?: number;
  itemIds?: Set<string>;
  outputDir?: string;
};

type PreparedMetadata = {
  dataset: DatasetName;
  created_at: string;
  source_items_path: string;
  item_count: number;
  workspace: string;
  forbidden_files_checked: string[];
};

const FORBIDDEN_BASENAME_PATTERNS = [
  /answer/i,
  /answer_key/i,
  /manifest/i,
  /corpus/i,
  /font/i,
];

const FORBIDDEN_EXTENSIONS = new Set([
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".ttc",
  ".otc",
]);

function usage(): string {
  return `Usage: bun run inference:prepare [--dataset dev-open|private-mixed] [--limit N] [--item sample_00000] [--out /tmp/path]

Creates a sanitized inference workspace outside the repo containing only:
- items.json
- images/*.png
- README.md
- workspace_metadata.json

No answer keys, font corpus, manifests, or font files are copied.`;
}

function rootRelative(path: string): string {
  return relative(ROOT, path).split("\\").join("/");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 10);
}

function parseDataset(value: string): DatasetName {
  if (value === "dev-open" || value === "private-mixed") return value;
  throw new Error(`Unknown dataset "${value}". Expected dev-open or private-mixed.`);
}

function defaultDataset(): DatasetName {
  return existsSync(resolve(ROOT, "dataset/private-mixed/items.json"))
    ? "private-mixed"
    : "dev-open";
}

function parseArgs(): PrepareOptions {
  const args = process.argv.slice(2);
  const options: PrepareOptions = { dataset: defaultDataset(), itemIds: new Set() };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--dataset") {
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
      options.itemIds?.add(itemId);
    } else if (arg === "--out") {
      const out = args[++index];
      if (!out) throw new Error("--out requires a path");
      options.outputDir = resolve(out);
    } else {
      throw new Error(`Unknown argument "${arg}".\n${usage()}`);
    }
  }

  return options;
}

function datasetDir(dataset: DatasetName): string {
  return resolve(ROOT, "dataset", dataset);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function assertOutputOutsideRepo(outputDir: string): void {
  if (isInside(ROOT, outputDir)) {
    throw new Error(
      `Refusing to create inference workspace inside repo: ${outputDir}. Use /tmp or another external directory.`,
    );
  }
}

function assertSafeImagePath(datasetPath: string, imagePath: string): string {
  if (imagePath.includes("..") || imagePath.startsWith("/")) {
    throw new Error(`Unsafe image path in dataset item: ${imagePath}`);
  }
  const resolved = resolve(datasetPath, imagePath);
  if (!isInside(datasetPath, resolved)) {
    throw new Error(`Image path escapes dataset directory: ${imagePath}`);
  }
  return resolved;
}

function sanitizeItem(item: DatasetItem): DatasetItem {
  const forbiddenKeys = ["answer", "font_id", "font_sha256", "image_sha256"];
  const presentForbiddenKeys = forbiddenKeys.filter((key) =>
    Object.prototype.hasOwnProperty.call(item, key),
  );
  if (presentForbiddenKeys.length > 0) {
    throw new Error(
      `Model-facing item ${item.id} contains forbidden key(s): ${presentForbiddenKeys.join(", ")}`,
    );
  }

  return {
    id: item.id,
    image: item.image,
    track: item.track,
    choices: [...item.choices],
    tier: { ...item.tier },
    determinable: item.determinable,
    render: { ...item.render },
  };
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

function extension(path: string): string {
  const match = path.toLowerCase().match(/\.[^.]+$/);
  return match?.[0] ?? "";
}

async function assertWorkspaceHasNoLeaks(workspace: string): Promise<string[]> {
  const files = await listFilesRecursive(workspace);
  const leaks = files.filter((file) => {
    const rel = relative(workspace, file).split("\\").join("/");
    const basename = rel.split("/").at(-1) ?? rel;
    if (FORBIDDEN_EXTENSIONS.has(extension(basename))) return true;
    return FORBIDDEN_BASENAME_PATTERNS.some((pattern) => pattern.test(basename));
  });

  if (leaks.length > 0) {
    throw new Error(
      `Sanitized inference workspace contains forbidden files:\n${leaks
        .map((file) => `- ${file}`)
        .join("\n")}`,
    );
  }

  return files.map((file) => relative(workspace, file).split("\\").join("/")).sort();
}

async function createOutputDir(options: PrepareOptions): Promise<string> {
  if (options.outputDir) {
    assertOutputOutsideRepo(options.outputDir);
    await mkdir(options.outputDir, { recursive: true });
    return options.outputDir;
  }

  await mkdir(INFERENCE_TMP_ROOT, { recursive: true });
  const prefix = resolve(
    INFERENCE_TMP_ROOT,
    `${options.dataset}-${new Date().toISOString().replace(/[:.]/g, "-")}-${sha256(
      process.cwd(),
    )}-`,
  );
  return mkdtemp(prefix);
}

async function prepareInferenceWorkspace(options: PrepareOptions): Promise<PreparedMetadata> {
  const sourceDatasetDir = datasetDir(options.dataset);
  const sourceItemsPath = resolve(sourceDatasetDir, "items.json");
  if (!existsSync(sourceItemsPath)) {
    throw new Error(
      `Missing ${rootRelative(sourceItemsPath)}. Run "bun run dataset:all" first.`,
    );
  }

  const payload = await readJson<DatasetPayload>(sourceItemsPath);
  let selectedItems = payload.items;

  if (options.itemIds && options.itemIds.size > 0) {
    selectedItems = selectedItems.filter((item) => options.itemIds?.has(item.id));
    const found = new Set(selectedItems.map((item) => item.id));
    const missing = [...options.itemIds].filter((itemId) => !found.has(itemId));
    if (missing.length > 0) {
      throw new Error(`Unknown item id(s): ${missing.join(", ")}`);
    }
  }

  if (options.limit !== undefined) {
    selectedItems = selectedItems.slice(0, options.limit);
  }

  const workspace = await createOutputDir(options);
  const imageDir = resolve(workspace, "images");
  await mkdir(imageDir, { recursive: true });

  const sanitizedItems = selectedItems.map(sanitizeItem);
  for (const item of sanitizedItems) {
    const sourceImage = assertSafeImagePath(sourceDatasetDir, item.image);
    if (!existsSync(sourceImage)) {
      throw new Error(`Missing image for item ${item.id}: ${sourceImage}`);
    }
    const targetImage = resolve(workspace, item.image);
    await mkdir(dirname(targetImage), { recursive: true });
    await copyFile(sourceImage, targetImage);
  }

  await writeJson(resolve(workspace, "items.json"), {
    dataset: options.dataset,
    items: sanitizedItems,
  });
  await writeFile(
    resolve(workspace, "README.md"),
    `# font-bench inference workspace

This workspace is safe to expose to a model/agent.

It intentionally contains only model-facing benchmark inputs:

- \`items.json\`
- \`images/*.png\`

It must not contain answer keys, corpus manifests, source fonts, or repository files.
`,
    "utf8",
  );

  const checkedFiles = await assertWorkspaceHasNoLeaks(workspace);
  const metadata: PreparedMetadata = {
    dataset: options.dataset,
    created_at: new Date().toISOString(),
    source_items_path: rootRelative(sourceItemsPath),
    item_count: sanitizedItems.length,
    workspace,
    forbidden_files_checked: [...checkedFiles, "workspace_metadata.json"].sort(),
  };
  await writeJson(resolve(workspace, "workspace_metadata.json"), metadata);

  // Check again after writing metadata.
  await assertWorkspaceHasNoLeaks(workspace);
  return metadata;
}

const metadata = await prepareInferenceWorkspace(parseArgs());
console.log(JSON.stringify(metadata, null, 2));
