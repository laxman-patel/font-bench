#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OPEN_FONT_SPEC = resolve(ROOT, "corpus/open_fonts.json");
const GENERATED_MANIFEST = resolve(ROOT, "corpus/manifest.generated.json");
const OPEN_CORPUS_DIR = resolve(ROOT, "corpus/open");
const PRIVATE_FONT_DIR = resolve(ROOT, "corpus/private/proprietary");
const PRIVATE_MANIFEST = resolve(ROOT, "corpus/private/manifest.generated.local.json");
const DATASET_DIR = resolve(ROOT, "dataset/dev-open");
const IMAGES_DIR = resolve(DATASET_DIR, "images");
const PRIVATE_DATASET_DIR = resolve(ROOT, "dataset/private-mixed");
const PRIVATE_IMAGES_DIR = resolve(PRIVATE_DATASET_DIR, "images");

const CSS_ENDPOINT = "https://fonts.googleapis.com/css2";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const TEXT_SAMPLES = [
  "Hamburgefontsiv",
  "The quick brown fox jumps",
  "a e g R Q t y 123",
] as const;

const RENDER_VARIANTS = [
  {
    name: "plain-32",
    size: 32,
    canvas: [256, 96] as const,
    foreground: [24, 24, 24] as const,
    background: [250, 250, 250] as const,
    rotationDeg: 0,
  },
  {
    name: "soft-28",
    size: 28,
    canvas: [256, 96] as const,
    foreground: [48, 48, 48] as const,
    background: [245, 245, 242] as const,
    rotationDeg: 1,
  },
] as const;

type Command = "download" | "render" | "validate" | "private" | "all";

type FontSpecFile = {
  version: number;
  source: string;
  weight: number;
  style: string;
  fonts: FontSpec[];
};

type FontSpec = {
  id: string;
  family: string;
  category: string;
  cluster: string;
  license: string;
};

type ManifestFont = FontSpec & {
  style: string;
  weight: number;
  source: string;
  font_path: string;
  font_sha256: string;
  kind: "open" | "proprietary";
  css_url?: string;
  source_url?: string;
  css_path?: string;
  woff2_path?: string;
  woff2_sha256?: string;
  redistribute_font: false;
  publish_rasters: boolean;
};

type GeneratedManifest = {
  generated_at: string;
  open_font_spec: string;
  open_font_spec_version: number;
  fonts: ManifestFont[];
};

type DatasetItem = {
  id: string;
  image: string;
  track: "mcq";
  choices: string[];
  tier: {
    pair_similarity: "seed";
    render_nuisance: "low";
  };
  determinable: true;
  render: {
    text: string;
    size: number;
    variant: string;
    seed: string;
  };
};

type AnswerKey = {
  dataset: string;
  generated_at: string;
  answers: Record<
    string,
    {
      answer: string;
      font_id: string;
      font_sha256: string;
      image_sha256: string;
    }
  >;
};

type ValidationReport = {
  dataset: string;
  font_count: number;
  item_count: number;
  image_count: number;
  missing_images: string[];
  missing_answers: string[];
  unexpected_answers: string[];
  font_paths_missing: string[];
  valid: boolean;
};

type GlyphDraw = {
  path: string;
  x: number;
  y: number;
};

function rootRelative(path: string): string {
  return relative(ROOT, path).split("\\").join("/");
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return sha256Bytes(await readFile(path));
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function googleCssUrl(family: string, weight: number): string {
  const query = new URLSearchParams({
    family: `${family}:wght@${weight}`,
    display: "swap",
  });
  return `${CSS_ENDPOINT}?${query.toString()}`;
}

function selectLatinFontUrl(css: string): string {
  const blocks = [...css.matchAll(/@font-face\s*\{(?<body>.*?)\}/gs)].map(
    (match) => match.groups?.body ?? "",
  );
  if (blocks.length === 0) {
    throw new Error("Google Fonts CSS did not contain any @font-face blocks");
  }

  const preferred =
    blocks.find((block) => block.toUpperCase().includes("U+0000-00FF")) ??
    blocks[blocks.length - 1];
  const match = preferred.match(
    /url\((https:\/\/[^)]+)\)\s+format\(['"]woff2['"]\)/,
  );
  if (!match) {
    throw new Error("Selected @font-face block did not contain a WOFF2 URL");
  }
  return match[1];
}

async function loadFontSpec(): Promise<FontSpecFile> {
  return readJson<FontSpecFile>(OPEN_FONT_SPEC);
}

async function downloadOpenFonts(): Promise<ManifestFont[]> {
  const spec = await loadFontSpec();
  const entries: ManifestFont[] = [];

  for (const font of spec.fonts) {
    const fontDir = resolve(OPEN_CORPUS_DIR, font.id);
    await mkdir(fontDir, { recursive: true });

    const cssUrl = googleCssUrl(font.family, spec.weight);
    const css = (await fetchBuffer(cssUrl)).toString("utf8");
    const sourceUrl = selectLatinFontUrl(css);
    const fontBytes = await fetchBuffer(sourceUrl);

    const cssPath = resolve(fontDir, "google-fonts.css");
    const woff2Path = resolve(fontDir, "font.woff2");
    await writeFile(cssPath, css, "utf8");
    await writeFile(woff2Path, fontBytes);

    entries.push({
      id: font.id,
      family: font.family,
      style: spec.style,
      weight: spec.weight,
      category: font.category,
      cluster: font.cluster,
      license: font.license,
      source: "google-fonts-css2",
      css_url: cssUrl,
      source_url: sourceUrl,
      css_path: rootRelative(cssPath),
      woff2_path: rootRelative(woff2Path),
      woff2_sha256: sha256Bytes(fontBytes),
      font_path: rootRelative(woff2Path),
      font_sha256: sha256Bytes(fontBytes),
      kind: "open",
      redistribute_font: false,
      publish_rasters: true,
    });
  }

  const manifest: GeneratedManifest = {
    generated_at: new Date().toISOString(),
    open_font_spec: rootRelative(OPEN_FONT_SPEC),
    open_font_spec_version: spec.version,
    fonts: entries,
  };
  await writeJson(GENERATED_MANIFEST, manifest);
  return entries;
}

async function loadGeneratedManifest(): Promise<ManifestFont[]> {
  if (!existsSync(GENERATED_MANIFEST)) {
    return downloadOpenFonts();
  }
  const manifest = await readJson<GeneratedManifest>(GENERATED_MANIFEST);
  return manifest.fonts;
}

function privateFamilyName(folderName: string): string {
  const names: Record<string, string> = {
    Arial: "Arial",
    "Avenir-Next": "Avenir Next",
    Futura: "Futura",
    "Helvetica-Neue": "Helvetica Neue",
    "Proxima-Nova": "Proxima Nova",
    "Times-New-Roman": "Times New Roman",
  };
  return names[folderName] ?? folderName.replaceAll("-", " ");
}

function privateCategory(folderName: string): string {
  return folderName === "Times-New-Roman" ? "serif" : "sans";
}

function privateCluster(folderName: string): string {
  const clusters: Record<string, string> = {
    Arial: "neo-grotesque-sans",
    "Avenir-Next": "geometric-sans",
    Futura: "geometric-sans",
    "Helvetica-Neue": "neo-grotesque-sans",
    "Proxima-Nova": "geometric-sans",
    "Times-New-Roman": "transitional-serif",
  };
  return clusters[folderName] ?? "proprietary";
}

async function listFontFiles(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = resolve(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFontFiles(fullPath)));
    } else if (/\.(ttf|otf|woff2?|ttc|otc)$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function regularFaceScore(path: string): number {
  const name = path.toLowerCase();
  let score = 0;
  if (name.includes("regular")) score -= 100;
  if (name.includes("roman")) score -= 90;
  if (name.includes("book")) score -= 80;
  if (/\/times\.ttf$/.test(name)) score -= 100;
  if (/\/arial\.ttf$/.test(name)) score -= 100;
  if (name.includes("bold")) score += 60;
  if (name.includes("black")) score += 70;
  if (name.includes("heavy")) score += 65;
  if (name.includes("italic") || name.includes("oblique")) score += 80;
  if (name.includes("light")) score += 35;
  if (name.includes("thin")) score += 45;
  if (name.includes("condensed") || name.includes("narrow")) score += 50;
  if (name.includes("ce")) score += 40;
  return score;
}

async function scanPrivateFonts(): Promise<ManifestFont[]> {
  if (!existsSync(PRIVATE_FONT_DIR)) return [];

  const familyDirs = (await readdir(PRIVATE_FONT_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const privateFonts: ManifestFont[] = [];

  for (const folderName of familyDirs) {
    const folderPath = resolve(PRIVATE_FONT_DIR, folderName);
    const candidates = (await listFontFiles(folderPath)).sort((a, b) => {
      const scoreDelta = regularFaceScore(a) - regularFaceScore(b);
      return scoreDelta === 0 ? a.localeCompare(b) : scoreDelta;
    });
    if (candidates.length === 0) continue;

    const fontPath = candidates[0];
    fontkit.openSync(fontPath);
    privateFonts.push({
      id: `private-${folderName.toLowerCase()}`,
      family: privateFamilyName(folderName),
      style: "normal",
      weight: 400,
      category: privateCategory(folderName),
      cluster: privateCluster(folderName),
      license: "proprietary",
      source: "local-licensed-copy",
      font_path: rootRelative(fontPath),
      font_sha256: await sha256File(fontPath),
      kind: "proprietary",
      redistribute_font: false,
      publish_rasters: false,
    });
  }

  await writeJson(PRIVATE_MANIFEST, {
    generated_at: new Date().toISOString(),
    source_dir: rootRelative(PRIVATE_FONT_DIR),
    fonts: privateFonts,
  });
  return privateFonts;
}

function seededShuffle<T>(items: T[], seed: string): T[] {
  const result = [...items];
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);

  function next(): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(next() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function pickChoices(
  fonts: ManifestFont[],
  answerId: string,
  seed: string,
  choiceCount = 4,
): string[] {
  const answer = fonts.find((font) => font.id === answerId);
  if (!answer) throw new Error(`Unknown answer font id: ${answerId}`);

  const sameCategory = seededShuffle(
    fonts.filter((font) => font.category === answer.category && font.id !== answerId),
    `${seed}:same-category`,
  );
  const others = seededShuffle(
    fonts.filter((font) => font.category !== answer.category),
    `${seed}:other-category`,
  );
  const selected = [answer, ...sameCategory].slice(0, choiceCount);
  if (selected.length < choiceCount) {
    selected.push(...others.slice(0, choiceCount - selected.length));
  }
  return seededShuffle(
    selected.slice(0, choiceCount).map((font) => font.family),
    `${seed}:choices`,
  );
}

function rgb(color: readonly [number, number, number]): string {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function renderGlyphSvg(input: {
  fontPath: string;
  text: string;
  size: number;
  canvas: readonly [number, number];
  foreground: readonly [number, number, number];
  background: readonly [number, number, number];
  rotationDeg: number;
}): string {
  const font = fontkit.openSync(input.fontPath);
  const layout = font.layout(input.text);
  const unitsPerEm = Number(font.unitsPerEm);
  const scale = input.size / unitsPerEm;
  const glyphs = layout.glyphs as any[];
  const positions = layout.positions as any[];

  let cursorX = 0;
  let minX = 0;
  let maxX = 0;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const glyphDraws: GlyphDraw[] = [];

  for (let index = 0; index < glyphs.length; index += 1) {
    const glyph = glyphs[index];
    const position = positions[index] ?? {};
    const xOffset = Number(position.xOffset ?? 0);
    const yOffset = Number(position.yOffset ?? 0);
    const xAdvance = Number(position.xAdvance ?? glyph.advanceWidth ?? 0);
    const bbox = glyph.bbox;
    const path = glyph.path?.toSVG?.() as string | undefined;

    if (bbox && path) {
      const glyphMinX = cursorX + xOffset + Number(bbox.minX);
      const glyphMaxX = cursorX + xOffset + Number(bbox.maxX);
      const glyphMinY = yOffset + Number(bbox.minY);
      const glyphMaxY = yOffset + Number(bbox.maxY);
      minX = Math.min(minX, glyphMinX);
      maxX = Math.max(maxX, glyphMaxX);
      minY = Math.min(minY, glyphMinY);
      maxY = Math.max(maxY, glyphMaxY);
      glyphDraws.push({ path, x: cursorX + xOffset, y: yOffset });
    }

    cursorX += xAdvance;
    maxX = Math.max(maxX, cursorX);
  }

  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
    minY = Number(font.descender);
    maxY = Number(font.ascender);
  }

  const [canvasWidth, canvasHeight] = input.canvas;
  const textWidth = (maxX - minX) * scale;
  const textHeight = (maxY - minY) * scale;
  const originX = (canvasWidth - textWidth) / 2 - minX * scale;
  const baselineY = (canvasHeight - textHeight) / 2 + maxY * scale;

  const paths = glyphDraws
    .map((glyph) => {
      const x = originX + glyph.x * scale;
      const y = baselineY - glyph.y * scale;
      return `<path d="${glyph.path}" transform="translate(${x.toFixed(3)} ${y.toFixed(
        3,
      )}) scale(${scale.toFixed(8)} ${(-scale).toFixed(8)})" />`;
    })
    .join("\n");

  const cx = canvasWidth / 2;
  const cy = canvasHeight / 2;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">
  <rect width="100%" height="100%" fill="${rgb(input.background)}" />
  <g fill="${rgb(input.foreground)}" transform="rotate(${input.rotationDeg} ${cx} ${cy})">
${paths}
  </g>
</svg>`;
}

async function renderTextImage(input: {
  fontPath: string;
  text: string;
  outputPath: string;
  size: number;
  canvas: readonly [number, number];
  foreground: readonly [number, number, number];
  background: readonly [number, number, number];
  rotationDeg: number;
}): Promise<void> {
  const svg = renderGlyphSvg(input);
  await mkdir(dirname(input.outputPath), { recursive: true });
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(input.outputPath);
}

async function renderDataset(input?: {
  datasetName?: string;
  datasetDir?: string;
  imagesDir?: string;
  fonts?: ManifestFont[];
}): Promise<{
  publicItems: DatasetItem[];
  answerKey: AnswerKey;
}> {
  const datasetName = input?.datasetName ?? "dev-open";
  const datasetDir = input?.datasetDir ?? DATASET_DIR;
  const imagesDir = input?.imagesDir ?? IMAGES_DIR;
  const fonts = input?.fonts ?? (await loadGeneratedManifest());
  await mkdir(imagesDir, { recursive: true });

  const publicItems: DatasetItem[] = [];
  const answerKey: AnswerKey = {
    dataset: datasetName,
    generated_at: new Date().toISOString(),
    answers: {},
  };

  let sampleIndex = 0;
  for (const font of fonts) {
    for (const [textIndex, text] of TEXT_SAMPLES.entries()) {
      for (const variant of RENDER_VARIANTS) {
        const sampleId = `sample_${sampleIndex.toString().padStart(5, "0")}`;
        const seed = `${datasetName}:v1:${font.id}:${textIndex}:${variant.name}`;
        const outputPath = resolve(imagesDir, `${sampleId}.png`);
        const fontPath = resolve(ROOT, font.font_path);

        await renderTextImage({
          fontPath,
          text,
          outputPath,
          size: variant.size,
          canvas: variant.canvas,
          foreground: variant.foreground,
          background: variant.background,
          rotationDeg: variant.rotationDeg,
        });

        const choices = pickChoices(fonts, font.id, seed);
        publicItems.push({
          id: sampleId,
          image: `images/${sampleId}.png`,
          track: "mcq",
          choices,
          tier: {
            pair_similarity: "seed",
            render_nuisance: "low",
          },
          determinable: true,
          render: {
            text,
            size: variant.size,
            variant: variant.name,
            seed,
          },
        });
        answerKey.answers[sampleId] = {
          answer: font.family,
          font_id: font.id,
          font_sha256: font.font_sha256,
          image_sha256: await sha256File(outputPath),
        };
        sampleIndex += 1;
      }
    }
  }

  await writeJson(resolve(datasetDir, "items.json"), {
    dataset: datasetName,
    items: publicItems,
  });
  await writeJson(resolve(datasetDir, "answer_key.json"), answerKey);
  return { publicItems, answerKey };
}

async function countPngFiles(path: string): Promise<number> {
  if (!existsSync(path)) return 0;
  const glob = new Bun.Glob("*.png");
  let count = 0;
  for await (const _file of glob.scan(path)) {
    count += 1;
  }
  return count;
}

async function validateDataset(input?: {
  datasetName?: string;
  datasetDir?: string;
  imagesDir?: string;
  fonts?: ManifestFont[];
}): Promise<ValidationReport> {
  const datasetName = input?.datasetName ?? "dev-open";
  const datasetDir = input?.datasetDir ?? DATASET_DIR;
  const imagesDir = input?.imagesDir ?? IMAGES_DIR;
  const fonts = input?.fonts ?? (await loadGeneratedManifest());
  const itemsPath = resolve(datasetDir, "items.json");
  const answersPath = resolve(datasetDir, "answer_key.json");

  if (!existsSync(itemsPath) || !existsSync(answersPath)) {
    await renderDataset({ datasetName, datasetDir, imagesDir, fonts });
  }

  const itemsPayload = await readJson<{ dataset: string; items: DatasetItem[] }>(itemsPath);
  const answerKey = await readJson<AnswerKey>(answersPath);
  const itemIds = new Set(itemsPayload.items.map((item) => item.id));
  const answerIds = new Set(Object.keys(answerKey.answers));

  const report: ValidationReport = {
    dataset: datasetName,
    font_count: fonts.length,
    item_count: itemsPayload.items.length,
    image_count: await countPngFiles(imagesDir),
    missing_images: itemsPayload.items
      .filter((item) => !existsSync(resolve(datasetDir, item.image)))
      .map((item) => item.image),
    missing_answers: itemsPayload.items
      .filter((item) => !answerIds.has(item.id))
      .map((item) => item.id),
    unexpected_answers: [...answerIds].filter((sampleId) => !itemIds.has(sampleId)),
    font_paths_missing: fonts
      .filter((font) => !existsSync(resolve(ROOT, font.font_path)))
      .map((font) => font.font_path),
    valid: false,
  };
  report.valid =
    report.missing_images.length === 0 &&
    report.missing_answers.length === 0 &&
    report.unexpected_answers.length === 0 &&
    report.font_paths_missing.length === 0;

  await writeJson(resolve(datasetDir, "validation.json"), report);
  await writeReport(report);
  return report;
}

async function writeReport(report: ValidationReport): Promise<void> {
  const status = report.valid ? "PASS" : "FAIL";
  const datasetDir = report.dataset === "private-mixed" ? PRIVATE_DATASET_DIR : DATASET_DIR;
  const manifestPath =
    report.dataset === "private-mixed"
      ? "corpus/private/manifest.generated.local.json"
      : "corpus/manifest.generated.json";
  const body = `# ${report.dataset} Dataset Build Report

Status: **${status}**

- Fonts: ${report.font_count}
- Items: ${report.item_count}
- Images: ${report.image_count}
- Missing images: ${report.missing_images.length}
- Missing answers: ${report.missing_answers.length}
- Unexpected answers: ${report.unexpected_answers.length}
- Missing font files: ${report.font_paths_missing.length}

Generated files:

- \`${manifestPath}\`
- \`${rootRelative(resolve(datasetDir, "items.json"))}\`
- \`${rootRelative(resolve(datasetDir, "answer_key.json"))}\`
- \`${rootRelative(resolve(datasetDir, "validation.json"))}\`
`;
  await writeFile(resolve(datasetDir, "build_report.md"), body, "utf8");
}

async function buildAll(): Promise<ValidationReport> {
  await downloadOpenFonts();
  await renderDataset();
  const openReport = await validateDataset();
  const privateReport = await buildPrivateMixedDataset();
  return privateReport ?? openReport;
}

async function buildPrivateMixedDataset(): Promise<ValidationReport | undefined> {
  const openFonts = await loadGeneratedManifest();
  const privateFonts = await scanPrivateFonts();
  if (privateFonts.length === 0) return undefined;

  const fonts = [...openFonts, ...privateFonts];
  await renderDataset({
    datasetName: "private-mixed",
    datasetDir: PRIVATE_DATASET_DIR,
    imagesDir: PRIVATE_IMAGES_DIR,
    fonts,
  });
  return validateDataset({
    datasetName: "private-mixed",
    datasetDir: PRIVATE_DATASET_DIR,
    imagesDir: PRIVATE_IMAGES_DIR,
    fonts,
  });
}

function parseCommand(): Command {
  const command = process.argv[2] ?? "all";
  if (
    command === "download" ||
    command === "render" ||
    command === "validate" ||
    command === "private" ||
    command === "all"
  ) {
    return command;
  }
  throw new Error(
    `Unknown command "${command}". Expected download, render, validate, private, or all.`,
  );
}

async function main(): Promise<void> {
  const command = parseCommand();
  if (command === "download") {
    const entries = await downloadOpenFonts();
    console.log(`Downloaded ${entries.length} open fonts`);
  } else if (command === "render") {
    const { publicItems } = await renderDataset();
    console.log(`Rendered ${publicItems.length} dataset items`);
  } else if (command === "validate") {
    const report = await validateDataset();
    console.log(`Validation ${report.valid ? "passed" : "failed"}`);
  } else if (command === "private") {
    const report = await buildPrivateMixedDataset();
    if (!report) {
      throw new Error(`No private fonts found under ${PRIVATE_FONT_DIR}`);
    }
    console.log(
      `Built private-mixed: ${report.font_count} fonts, ${report.item_count} items, valid=${report.valid}`,
    );
  } else {
    const report = await buildAll();
    console.log(
      `Built ${report.dataset}: ${report.font_count} fonts, ${report.item_count} items, valid=${report.valid}`,
    );
  }
}

await main();
