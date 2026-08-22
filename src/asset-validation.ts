import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import * as path from "node:path";

import { discoverProject } from "./project.js";

export const MAX_ASSET_CLOSURE_FILES = 256;
export const MAX_ASSET_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_ASSET_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_ASSET_FINDINGS = 256;
export const MAX_ASSET_JSON_DEPTH = 64;
export const MAX_ASSET_JSON_STRING_BYTES = 1024 * 1024;
export const MAX_ASSET_JSON_ARRAY_ITEMS = 1_000_000;

const MAX_ASSET_JSON_VALUES = 1_000_000;
const BOUNDARY =
  "Static or isolated import evidence is not GPU, VRAM, visual-quality, collision-quality, or OpenXR proof.";

export interface AssetValidationOptions {
  asset: string;
  project?: string;
  policy?: string;
  godotImport?: boolean;
  godot?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface AssetFinding {
  severity: "error" | "warning";
  code: string;
  location: string;
  message: string;
}

export interface AssetClosureFile {
  resourcePath: string;
  bytes: number;
  sha256: string;
  kind: "root" | "buffer" | "image";
}

export interface AssetMetrics {
  scenes: number;
  nodes: number;
  meshes: number;
  primitives: number;
  materials: number;
  textures: number;
  images: number;
  samplers: number;
  skins: number;
  animations: number;
  accessors: number;
  declaredBufferBytes: number;
  primitiveModes: Record<string, number>;
  triangles: { value: number | null; reason: string | null };
}

export interface AssetImageMetadata {
  resourcePath: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
}

export interface AssetValidationReport {
  status: "ok" | "error";
  valid: boolean;
  complete: boolean;
  asset: string;
  projectRoot: string;
  format: "gltf" | "glb";
  proof: {
    static: { status: "ok" | "error"; complete: boolean };
    godotImport: {
      status: "ok" | "error" | "not_requested";
      complete: boolean;
    };
  };
  closure: {
    fileCount: number;
    totalBytes: number;
    files: AssetClosureFile[];
  };
  metrics: AssetMetrics;
  images: AssetImageMetadata[];
  evidence: {
    lod: { status: "unknown"; reason: string };
    collision: {
      status: "unknown" | "observed";
      collisionShapes: number | null;
      reason: string;
    };
  };
  policy: null | {
    resourcePath: string;
    schema: "uo-godot-asset-policy/1";
    passed: boolean;
  };
  findings: AssetFinding[];
  integrity: { unchanged: boolean };
  boundaries: string[];
}

interface ResolvedAsset {
  resourcePath: string;
  absolutePath: string;
  format: "gltf" | "glb";
  bytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function emptyMetrics(): AssetMetrics {
  return {
    scenes: 0,
    nodes: 0,
    meshes: 0,
    primitives: 0,
    materials: 0,
    textures: 0,
    images: 0,
    samplers: 0,
    skins: 0,
    animations: 0,
    accessors: 0,
    declaredBufferBytes: 0,
    primitiveModes: {},
    triangles: { value: 0, reason: null },
  };
}

async function resolveAsset(
  projectRoot: string,
  resourcePath: string
): Promise<ResolvedAsset> {
  if (!resourcePath.startsWith("res://")) {
    throw new Error("Asset validation requires a res:// path");
  }
  const extension = path.posix.extname(resourcePath).toLowerCase();
  if (extension !== ".gltf" && extension !== ".glb") {
    throw new Error("Asset validation accepts only .gltf or .glb files");
  }
  const relative = resourcePath.slice("res://".length).replaceAll("/", path.sep);
  const absolutePath = path.resolve(projectRoot, relative);
  const within = path.relative(projectRoot, absolutePath);
  if (
    within === ".." ||
    within.startsWith(`..${path.sep}`) ||
    path.isAbsolute(within)
  ) {
    throw new Error("Asset validation path must stay inside the Godot project");
  }

  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (error) {
    if (isNotFound(error)) throw new Error(`Asset not found: ${resourcePath}`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Asset must be a regular project file: ${resourcePath}`);
  }
  if (stat.size > MAX_ASSET_FILE_BYTES) {
    throw new Error(
      `Asset exceeds the ${MAX_ASSET_FILE_BYTES}-byte validation limit: ${resourcePath}`
    );
  }

  const canonicalProject = await fs.realpath(projectRoot);
  const canonicalAsset = await fs.realpath(absolutePath);
  const canonicalWithin = path.relative(canonicalProject, canonicalAsset);
  if (
    canonicalWithin === ".." ||
    canonicalWithin.startsWith(`..${path.sep}`) ||
    path.isAbsolute(canonicalWithin)
  ) {
    throw new Error("Asset validation path must stay inside the Godot project");
  }

  return {
    resourcePath,
    absolutePath: canonicalAsset,
    format: extension === ".gltf" ? "gltf" : "glb",
    bytes: stat.size,
  };
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(digest.digest("hex")));
  });
}

function validateJsonShape(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    visited += 1;
    if (visited > MAX_ASSET_JSON_VALUES) {
      throw new Error(`Asset JSON exceeds the ${MAX_ASSET_JSON_VALUES}-value limit`);
    }
    if (current.depth > MAX_ASSET_JSON_DEPTH) {
      throw new Error(`Asset JSON exceeds the depth limit of ${MAX_ASSET_JSON_DEPTH}`);
    }
    if (typeof current.value === "number" && !Number.isFinite(current.value)) {
      throw new Error("Asset JSON contains a non-finite number");
    }
    if (typeof current.value === "string") {
      if (Buffer.byteLength(current.value, "utf8") > MAX_ASSET_JSON_STRING_BYTES) {
        throw new Error("Asset JSON contains an oversized string");
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_ASSET_JSON_ARRAY_ITEMS) {
        throw new Error("Asset JSON contains an oversized array");
      }
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (isRecord(current.value)) {
      for (const [key, child] of Object.entries(current.value)) {
        if (key === "__proto__" || key === "prototype" || key === "constructor") {
          throw new Error(`Asset JSON contains forbidden key: ${key}`);
        }
        if (Buffer.byteLength(key, "utf8") > MAX_ASSET_JSON_STRING_BYTES) {
          throw new Error("Asset JSON contains an oversized object key");
        }
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function parseGltf(bytes: Buffer): Record<string, unknown> {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error("Asset JSON must not contain a UTF-8 BOM");
  }
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(parsed)) throw new Error("Asset JSON root must be an object");
  validateJsonShape(parsed);
  const asset = parsed.asset;
  if (!isRecord(asset) || asset.version !== "2.0") {
    throw new Error('Asset must declare glTF asset.version "2.0"');
  }
  return parsed;
}

function collectMetrics(gltf: Record<string, unknown>): AssetMetrics {
  const metrics = emptyMetrics();
  metrics.scenes = arrayLength(gltf.scenes);
  metrics.nodes = arrayLength(gltf.nodes);
  metrics.meshes = arrayLength(gltf.meshes);
  metrics.materials = arrayLength(gltf.materials);
  metrics.textures = arrayLength(gltf.textures);
  metrics.images = arrayLength(gltf.images);
  metrics.samplers = arrayLength(gltf.samplers);
  metrics.skins = arrayLength(gltf.skins);
  metrics.animations = arrayLength(gltf.animations);
  metrics.accessors = arrayLength(gltf.accessors);

  if (Array.isArray(gltf.meshes)) {
    for (const mesh of gltf.meshes) {
      if (!isRecord(mesh) || !Array.isArray(mesh.primitives)) continue;
      metrics.primitives += mesh.primitives.length;
    }
  }
  if (metrics.primitives > 0) {
    metrics.triangles = {
      value: null,
      reason: "Primitive topology has not been resolved",
    };
  }
  return metrics;
}

function findingFromError(error: unknown): AssetFinding {
  return {
    severity: "error",
    code: "ASSET_GLTF_INVALID",
    location: "/",
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function validateAsset(
  options: AssetValidationOptions
): Promise<AssetValidationReport> {
  const env = options.env ?? process.env;
  const discovery = await discoverProject(options.project, {
    cwd: options.cwd,
    env,
  });
  const resolved = await resolveAsset(discovery.projectRoot, options.asset);
  const beforeSha256 = await sha256File(resolved.absolutePath);
  const rootClosure: AssetClosureFile = {
    resourcePath: resolved.resourcePath,
    bytes: resolved.bytes,
    sha256: beforeSha256,
    kind: "root",
  };
  const findings: AssetFinding[] = [];
  let metrics = emptyMetrics();

  try {
    const bytes = await fs.readFile(resolved.absolutePath);
    if (resolved.format === "glb") {
      throw new Error("GLB validation is not available in this proof layer");
    }
    metrics = collectMetrics(parseGltf(bytes));
  } catch (error) {
    findings.push(findingFromError(error));
  }

  const afterStat = await fs.lstat(resolved.absolutePath);
  const afterSha256 = await sha256File(resolved.absolutePath);
  const unchanged =
    afterStat.isFile() &&
    !afterStat.isSymbolicLink() &&
    afterStat.size === resolved.bytes &&
    afterSha256 === beforeSha256;
  if (!unchanged) {
    findings.push({
      severity: "error",
      code: "ASSET_SOURCE_CHANGED",
      location: resolved.resourcePath,
      message: "Asset source changed during validation",
    });
  }
  findings.sort((left, right) =>
    left.code.localeCompare(right.code) ||
    left.location.localeCompare(right.location) ||
    left.message.localeCompare(right.message)
  );

  const valid = findings.every((finding) => finding.severity !== "error");
  return {
    status: valid ? "ok" : "error",
    valid,
    complete: true,
    asset: resolved.resourcePath,
    projectRoot: discovery.projectRoot,
    format: resolved.format,
    proof: {
      static: { status: valid ? "ok" : "error", complete: true },
      godotImport: { status: "not_requested", complete: false },
    },
    closure: {
      fileCount: 1,
      totalBytes: resolved.bytes,
      files: [rootClosure],
    },
    metrics,
    images: [],
    evidence: {
      lod: {
        status: "unknown",
        reason: "LOD evidence requires a future versioned policy rule",
      },
      collision: {
        status: "unknown",
        collisionShapes: null,
        reason: "Static glTF validation cannot prove Godot collision nodes",
      },
    },
    policy: null,
    findings: findings.slice(0, MAX_ASSET_FINDINGS),
    integrity: { unchanged },
    boundaries: [BOUNDARY],
  };
}
