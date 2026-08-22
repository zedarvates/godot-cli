import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import * as path from "node:path";

import { discoverProject } from "./project.js";
import {
  runIsolatedGodotImport,
  type AssetImportReport,
} from "./asset-import.js";

export const MAX_ASSET_CLOSURE_FILES = 256;
export const MAX_ASSET_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_ASSET_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_ASSET_FINDINGS = 256;
export const MAX_ASSET_JSON_DEPTH = 64;
export const MAX_ASSET_JSON_STRING_BYTES = 1024 * 1024;
export const MAX_ASSET_JSON_ARRAY_ITEMS = 1_000_000;

const MAX_ASSET_JSON_VALUES = 1_000_000;
const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;
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
      summary?: AssetImportReport["summary"];
      exitCodes?: AssetImportReport["exitCodes"];
      logs?: AssetImportReport["logs"];
      cleanup?: AssetImportReport["cleanup"];
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

interface InternalClosureFile extends AssetClosureFile {
  absolutePath: string;
}

interface AssetPolicyV1 {
  schema: "uo-godot-asset-policy/1";
  max_total_bytes?: number;
  max_meshes?: number;
  max_primitives?: number;
  max_materials?: number;
  max_textures?: number;
  max_image_dimension?: number;
  require_godot_import?: boolean;
  require_collision_nodes?: boolean;
}

class AssetValidationError extends Error {
  constructor(
    readonly code: string,
    readonly location: string,
    message: string
  ) {
    super(message);
  }
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

function parseGlb(bytes: Buffer): Record<string, unknown> {
  if (bytes.length < 20) throw new Error("GLB header or JSON chunk is truncated");
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) throw new Error("GLB magic is invalid");
  if (bytes.readUInt32LE(4) !== 2) throw new Error("GLB version must be 2");
  if (bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error("GLB declared length does not match the file length");
  }
  let offset = 12;
  let json: Record<string, unknown> | null = null;
  let binBytes: number | null = null;
  while (offset < bytes.length) {
    if (offset % 4 !== 0 || offset + 8 > bytes.length) {
      throw new Error("GLB chunk framing or alignment is invalid");
    }
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (length % 4 !== 0 || end > bytes.length) {
      throw new Error("GLB chunk length is invalid");
    }
    if (type === GLB_JSON_CHUNK) {
      if (json !== null || offset !== 12) {
        throw new Error("GLB must contain exactly one leading JSON chunk");
      }
      json = parseGltf(bytes.subarray(start, end));
    } else if (type === GLB_BIN_CHUNK) {
      if (json === null || binBytes !== null) {
        throw new Error("GLB BIN chunk is duplicate or precedes JSON");
      }
      binBytes = length;
    } else {
      throw new Error(`GLB contains unsupported chunk type 0x${type.toString(16)}`);
    }
    offset = end;
  }
  if (offset !== bytes.length || json === null) {
    throw new Error("GLB is missing a complete JSON chunk");
  }
  if (Array.isArray(json.buffers)) {
    const internal = json.buffers.filter(
      (buffer) => isRecord(buffer) && buffer.uri === undefined
    );
    if (internal.length > 1) throw new Error("GLB declares multiple internal buffers");
    if (internal.length === 1) {
      const declared = internal[0].byteLength;
      if (
        typeof declared !== "number" ||
        !Number.isSafeInteger(declared) ||
        declared < 0 ||
        binBytes === null ||
        declared > binBytes
      ) {
        throw new Error("GLB internal buffer does not match its BIN chunk");
      }
    } else if (binBytes !== null) {
      throw new Error("GLB BIN chunk has no matching internal buffer");
    }
  } else if (binBytes !== null) {
    throw new Error("GLB BIN chunk has no buffers declaration");
  }
  return json;
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
    let triangleTotal = 0;
    let triangleReason: string | null = null;
    const accessors = Array.isArray(gltf.accessors) ? gltf.accessors : [];
    for (const mesh of gltf.meshes) {
      if (!isRecord(mesh) || !Array.isArray(mesh.primitives)) continue;
      metrics.primitives += mesh.primitives.length;
      for (const primitive of mesh.primitives) {
        if (!isRecord(primitive)) {
          triangleReason = "Primitive is not an object";
          continue;
        }
        const mode = primitive.mode === undefined ? 4 : primitive.mode;
        if (typeof mode !== "number" || !Number.isInteger(mode)) {
          triangleReason = "Primitive mode is not an integer";
          continue;
        }
        const modeKey = String(mode);
        metrics.primitiveModes[modeKey] = (metrics.primitiveModes[modeKey] ?? 0) + 1;
        let accessorIndex: unknown = primitive.indices;
        if (accessorIndex === undefined && isRecord(primitive.attributes)) {
          accessorIndex = primitive.attributes.POSITION;
        }
        if (
          typeof accessorIndex !== "number" ||
          !Number.isInteger(accessorIndex) ||
          accessorIndex < 0 ||
          accessorIndex >= accessors.length ||
          !isRecord(accessors[accessorIndex]) ||
          typeof accessors[accessorIndex].count !== "number" ||
          !Number.isSafeInteger(accessors[accessorIndex].count) ||
          accessors[accessorIndex].count < 0
        ) {
          triangleReason = "Primitive accessor count is unavailable";
          continue;
        }
        const count = accessors[accessorIndex].count;
        let triangles: number;
        if (mode === 4) triangles = Math.floor(count / 3);
        else if (mode === 5 || mode === 6) triangles = Math.max(0, count - 2);
        else {
          triangleReason = `Primitive mode ${mode} is not triangular`;
          continue;
        }
        if (!Number.isSafeInteger(triangleTotal + triangles)) {
          triangleReason = "Triangle count exceeds the safe integer range";
          continue;
        }
        triangleTotal += triangles;
      }
    }
    metrics.triangles = triangleReason === null
      ? { value: triangleTotal, reason: null }
      : { value: null, reason: triangleReason };
  }
  if (Array.isArray(gltf.buffers)) {
    for (const buffer of gltf.buffers) {
      if (!isRecord(buffer)) continue;
      const declared = buffer.byteLength;
      if (
        typeof declared === "number" &&
        Number.isSafeInteger(declared) &&
        declared >= 0 &&
        Number.isSafeInteger(metrics.declaredBufferBytes + declared)
      ) {
        metrics.declaredBufferBytes += declared;
      }
    }
  }
  return metrics;
}

function checkIndex(
  value: unknown,
  targetLength: number,
  location: string,
  findings: AssetFinding[]
): void {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value >= targetLength
  ) {
    findings.push({
      severity: "error",
      code: "ASSET_REFERENCE_OUT_OF_RANGE",
      location,
      message: `Index must be an integer between 0 and ${Math.max(targetLength - 1, -1)}`,
    });
  }
}

function checkOptionalIndex(
  owner: Record<string, unknown>,
  key: string,
  targetLength: number,
  location: string,
  findings: AssetFinding[]
): void {
  if (owner[key] !== undefined) {
    checkIndex(owner[key], targetLength, `${location}/${key}`, findings);
  }
}

function validateReferences(
  gltf: Record<string, unknown>,
  findings: AssetFinding[]
): void {
  const scenes = Array.isArray(gltf.scenes) ? gltf.scenes : [];
  const nodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
  const meshes = Array.isArray(gltf.meshes) ? gltf.meshes : [];
  const skins = Array.isArray(gltf.skins) ? gltf.skins : [];
  const accessors = Array.isArray(gltf.accessors) ? gltf.accessors : [];
  const materials = Array.isArray(gltf.materials) ? gltf.materials : [];
  const textures = Array.isArray(gltf.textures) ? gltf.textures : [];
  const images = Array.isArray(gltf.images) ? gltf.images : [];
  const samplers = Array.isArray(gltf.samplers) ? gltf.samplers : [];
  const bufferViews = Array.isArray(gltf.bufferViews) ? gltf.bufferViews : [];
  const buffers = Array.isArray(gltf.buffers) ? gltf.buffers : [];

  if (gltf.scene !== undefined) checkIndex(gltf.scene, scenes.length, "/scene", findings);
  for (const [sceneIndex, scene] of scenes.entries()) {
    if (!isRecord(scene) || !Array.isArray(scene.nodes)) continue;
    for (const [index, node] of scene.nodes.entries()) {
      checkIndex(node, nodes.length, `/scenes/${sceneIndex}/nodes/${index}`, findings);
    }
  }
  for (const [nodeIndex, node] of nodes.entries()) {
    if (!isRecord(node)) continue;
    const location = `/nodes/${nodeIndex}`;
    checkOptionalIndex(node, "mesh", meshes.length, location, findings);
    checkOptionalIndex(node, "skin", skins.length, location, findings);
    if (Array.isArray(node.children)) {
      for (const [index, child] of node.children.entries()) {
        checkIndex(child, nodes.length, `${location}/children/${index}`, findings);
      }
    }
  }
  for (const [meshIndex, mesh] of meshes.entries()) {
    if (!isRecord(mesh) || !Array.isArray(mesh.primitives)) continue;
    for (const [primitiveIndex, primitive] of mesh.primitives.entries()) {
      if (!isRecord(primitive)) continue;
      const location = `/meshes/${meshIndex}/primitives/${primitiveIndex}`;
      checkOptionalIndex(primitive, "indices", accessors.length, location, findings);
      checkOptionalIndex(primitive, "material", materials.length, location, findings);
      if (isRecord(primitive.attributes)) {
        for (const [name, accessor] of Object.entries(primitive.attributes)) {
          checkIndex(accessor, accessors.length, `${location}/attributes/${name}`, findings);
        }
      }
    }
  }
  for (const [textureIndex, texture] of textures.entries()) {
    if (!isRecord(texture)) continue;
    const location = `/textures/${textureIndex}`;
    checkOptionalIndex(texture, "source", images.length, location, findings);
    checkOptionalIndex(texture, "sampler", samplers.length, location, findings);
  }
  for (const [accessorIndex, accessor] of accessors.entries()) {
    if (isRecord(accessor)) {
      checkOptionalIndex(
        accessor,
        "bufferView",
        bufferViews.length,
        `/accessors/${accessorIndex}`,
        findings
      );
    }
  }
  for (const [viewIndex, view] of bufferViews.entries()) {
    if (isRecord(view)) {
      checkOptionalIndex(view, "buffer", buffers.length, `/bufferViews/${viewIndex}`, findings);
    }
  }
  for (const [skinIndex, skin] of skins.entries()) {
    if (!isRecord(skin)) continue;
    const location = `/skins/${skinIndex}`;
    checkOptionalIndex(skin, "inverseBindMatrices", accessors.length, location, findings);
    checkOptionalIndex(skin, "skeleton", nodes.length, location, findings);
    if (Array.isArray(skin.joints)) {
      for (const [index, joint] of skin.joints.entries()) {
        checkIndex(joint, nodes.length, `${location}/joints/${index}`, findings);
      }
    }
  }
  if (Array.isArray(gltf.animations)) {
    for (const [animationIndex, animation] of gltf.animations.entries()) {
      if (!isRecord(animation)) continue;
      const animationSamplers = Array.isArray(animation.samplers) ? animation.samplers : [];
      for (const [samplerIndex, sampler] of animationSamplers.entries()) {
        if (!isRecord(sampler)) continue;
        const location = `/animations/${animationIndex}/samplers/${samplerIndex}`;
        checkOptionalIndex(sampler, "input", accessors.length, location, findings);
        checkOptionalIndex(sampler, "output", accessors.length, location, findings);
      }
      if (Array.isArray(animation.channels)) {
        for (const [channelIndex, channel] of animation.channels.entries()) {
          if (!isRecord(channel)) continue;
          const location = `/animations/${animationIndex}/channels/${channelIndex}`;
          checkOptionalIndex(channel, "sampler", animationSamplers.length, location, findings);
          if (isRecord(channel.target)) {
            checkOptionalIndex(channel.target, "node", nodes.length, `${location}/target`, findings);
          }
        }
      }
    }
  }
}

function dependencyUri(uri: string, location: string): string {
  if (
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri) ||
    uri.startsWith("//") ||
    uri.startsWith("/") ||
    uri.startsWith("\\") ||
    uri.includes("\\") ||
    uri.includes("?") ||
    uri.includes("#") ||
    uri.includes("\0")
  ) {
    throw new AssetValidationError(
      "ASSET_URI_FORBIDDEN",
      location,
      `Dependency URI is not a bounded local path: ${uri}`
    );
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    throw new AssetValidationError(
      "ASSET_URI_FORBIDDEN",
      location,
      `Dependency URI contains invalid percent encoding: ${uri}`
    );
  }
  if (
    decoded.length === 0 ||
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded)
  ) {
    throw new AssetValidationError(
      "ASSET_URI_FORBIDDEN",
      location,
      `Decoded dependency URI is not a bounded local path: ${uri}`
    );
  }
  return decoded;
}

async function resolveDependency(
  projectRoot: string,
  ownerAbsolutePath: string,
  uri: string,
  kind: "buffer" | "image",
  location: string
): Promise<InternalClosureFile> {
  const decoded = dependencyUri(uri, location);
  const candidate = path.resolve(
    path.dirname(ownerAbsolutePath),
    decoded.replaceAll("/", path.sep)
  );
  const within = path.relative(projectRoot, candidate);
  if (
    within === ".." ||
    within.startsWith(`..${path.sep}`) ||
    path.isAbsolute(within)
  ) {
    throw new AssetValidationError(
      "ASSET_URI_FORBIDDEN",
      location,
      `Dependency path escapes the Godot project: ${uri}`
    );
  }
  let stat;
  try {
    stat = await fs.lstat(candidate);
  } catch (error) {
    if (isNotFound(error)) {
      throw new AssetValidationError(
        "ASSET_DEPENDENCY_MISSING",
        location,
        `Dependency not found: ${uri}`
      );
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new AssetValidationError(
      "ASSET_DEPENDENCY_SYMLINK",
      location,
      `Dependency must not be a symbolic link: ${uri}`
    );
  }
  if (!stat.isFile()) {
    throw new AssetValidationError(
      "ASSET_DEPENDENCY_MISSING",
      location,
      `Dependency must be a regular file: ${uri}`
    );
  }
  if (stat.size > MAX_ASSET_FILE_BYTES) {
    throw new AssetValidationError(
      "ASSET_LIMIT_EXCEEDED",
      location,
      `Dependency exceeds the ${MAX_ASSET_FILE_BYTES}-byte file limit: ${uri}`
    );
  }
  const canonicalProject = await fs.realpath(projectRoot);
  const canonical = await fs.realpath(candidate);
  const canonicalWithin = path.relative(canonicalProject, canonical);
  if (
    canonicalWithin === ".." ||
    canonicalWithin.startsWith(`..${path.sep}`) ||
    path.isAbsolute(canonicalWithin)
  ) {
    throw new AssetValidationError(
      "ASSET_URI_FORBIDDEN",
      location,
      `Dependency resolves outside the Godot project: ${uri}`
    );
  }
  const resourcePath = `res://${path
    .relative(canonicalProject, canonical)
    .split(path.sep)
    .join("/")}`;
  return {
    resourcePath,
    absolutePath: canonical,
    bytes: stat.size,
    sha256: await sha256File(canonical),
    kind,
  };
}

async function collectClosure(
  projectRoot: string,
  root: ResolvedAsset,
  rootSha256: string,
  gltf: Record<string, unknown>,
  findings: AssetFinding[]
): Promise<InternalClosureFile[]> {
  const files: InternalClosureFile[] = [
    {
      resourcePath: root.resourcePath,
      absolutePath: root.absolutePath,
      bytes: root.bytes,
      sha256: rootSha256,
      kind: "root",
    },
  ];
  const seen = new Set([root.absolutePath.toLowerCase()]);
  const declarations: Array<{
    uri: string;
    kind: "buffer" | "image";
    location: string;
  }> = [];
  if (Array.isArray(gltf.buffers)) {
    for (const [index, buffer] of gltf.buffers.entries()) {
      if (isRecord(buffer) && typeof buffer.uri === "string") {
        declarations.push({
          uri: buffer.uri,
          kind: "buffer",
          location: `/buffers/${index}/uri`,
        });
      }
    }
  }
  if (Array.isArray(gltf.images)) {
    for (const [index, image] of gltf.images.entries()) {
      if (isRecord(image) && typeof image.uri === "string") {
        declarations.push({
          uri: image.uri,
          kind: "image",
          location: `/images/${index}/uri`,
        });
      }
    }
  }
  for (const declaration of declarations) {
    try {
      const dependency = await resolveDependency(
        projectRoot,
        root.absolutePath,
        declaration.uri,
        declaration.kind,
        declaration.location
      );
      const identity = dependency.absolutePath.toLowerCase();
      if (seen.has(identity)) continue;
      if (files.length >= MAX_ASSET_CLOSURE_FILES) {
        throw new AssetValidationError(
          "ASSET_LIMIT_EXCEEDED",
          declaration.location,
          `Asset closure exceeds ${MAX_ASSET_CLOSURE_FILES} files`
        );
      }
      const nextTotal = files.reduce((sum, file) => sum + file.bytes, 0) + dependency.bytes;
      if (nextTotal > MAX_ASSET_TOTAL_BYTES) {
        throw new AssetValidationError(
          "ASSET_LIMIT_EXCEEDED",
          declaration.location,
          `Asset closure exceeds ${MAX_ASSET_TOTAL_BYTES} bytes`
        );
      }
      seen.add(identity);
      files.push(dependency);
    } catch (error) {
      if (error instanceof AssetValidationError) {
        findings.push({
          severity: "error",
          code: error.code,
          location: error.location,
          message: error.message,
        });
      } else {
        throw error;
      }
    }
  }
  const rootFile = files[0];
  const dependencies = files
    .slice(1)
    .sort((left, right) => left.resourcePath.localeCompare(right.resourcePath));
  return [rootFile, ...dependencies];
}

async function readPrefix(file: string, maximum = 64 * 1024): Promise<Buffer> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    const bytes = Buffer.alloc(Math.min(stat.size, maximum));
    const result = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(signature) ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return null;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  const sofMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (sofMarkers.has(marker)) {
      if (length < 7) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

async function collectImageMetadata(
  projectRoot: string,
  root: ResolvedAsset,
  gltf: Record<string, unknown>,
  closure: InternalClosureFile[],
  findings: AssetFinding[]
): Promise<AssetImageMetadata[]> {
  if (!Array.isArray(gltf.images)) return [];
  const canonicalProject = await fs.realpath(projectRoot);
  const byPath = new Map(closure.map((file) => [file.absolutePath.toLowerCase(), file]));
  const result: AssetImageMetadata[] = [];
  for (const [index, image] of gltf.images.entries()) {
    if (!isRecord(image) || typeof image.uri !== "string") {
      result.push({
        resourcePath: null,
        mimeType: isRecord(image) && typeof image.mimeType === "string" ? image.mimeType : null,
        width: null,
        height: null,
      });
      continue;
    }
    let canonical: string;
    try {
      const decoded = dependencyUri(image.uri, `/images/${index}/uri`);
      canonical = await fs.realpath(
        path.resolve(path.dirname(root.absolutePath), decoded.replaceAll("/", path.sep))
      );
    } catch {
      result.push({ resourcePath: null, mimeType: null, width: null, height: null });
      continue;
    }
    const dependency = byPath.get(canonical.toLowerCase());
    const declaredMime = typeof image.mimeType === "string" ? image.mimeType : null;
    if (!dependency) {
      result.push({ resourcePath: null, mimeType: declaredMime, width: null, height: null });
      continue;
    }
    const extension = path.extname(canonical).toLowerCase();
    const inferredMime = extension === ".png"
      ? "image/png"
      : extension === ".jpg" || extension === ".jpeg"
        ? "image/jpeg"
        : null;
    const mimeType = declaredMime ?? inferredMime;
    const prefix = await readPrefix(canonical);
    const dimensions = mimeType === "image/png"
      ? pngDimensions(prefix)
      : mimeType === "image/jpeg"
        ? jpegDimensions(prefix)
        : null;
    if (declaredMime !== null && inferredMime !== null && declaredMime !== inferredMime) {
      findings.push({
        severity: "warning",
        code: "ASSET_IMAGE_MIME_MISMATCH",
        location: `/images/${index}/mimeType`,
        message: `Declared ${declaredMime} does not match ${inferredMime}`,
      });
    }
    if (dimensions === null && mimeType !== null) {
      findings.push({
        severity: "warning",
        code: "ASSET_IMAGE_DIMENSIONS_UNKNOWN",
        location: `/images/${index}`,
        message: "Image dimensions were not available from the bounded header",
      });
    }
    result.push({
      resourcePath: `res://${path.relative(canonicalProject, canonical).split(path.sep).join("/")}`,
      mimeType,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
    });
  }
  return result;
}

async function loadPolicy(
  projectRoot: string,
  resourcePath: string
): Promise<AssetPolicyV1> {
  if (!resourcePath.startsWith("res://") || !resourcePath.endsWith(".json")) {
    throw new Error("Asset policy requires a project-local res:// .json path");
  }
  const candidate = path.resolve(
    projectRoot,
    resourcePath.slice("res://".length).replaceAll("/", path.sep)
  );
  const within = path.relative(projectRoot, candidate);
  if (
    within === ".." ||
    within.startsWith(`..${path.sep}`) ||
    path.isAbsolute(within)
  ) {
    throw new Error("Asset policy path must stay inside the Godot project");
  }
  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Asset policy must be a regular project file");
  }
  if (stat.size > MAX_ASSET_JSON_STRING_BYTES) {
    throw new Error("Asset policy exceeds the 1 MiB limit");
  }
  const canonicalProject = await fs.realpath(projectRoot);
  const canonical = await fs.realpath(candidate);
  const canonicalWithin = path.relative(canonicalProject, canonical);
  if (
    canonicalWithin === ".." ||
    canonicalWithin.startsWith(`..${path.sep}`) ||
    path.isAbsolute(canonicalWithin)
  ) {
    throw new Error("Asset policy resolves outside the Godot project");
  }
  const parsed: unknown = JSON.parse(await fs.readFile(canonical, "utf8"));
  if (!isRecord(parsed) || parsed.schema !== "uo-godot-asset-policy/1") {
    throw new Error("Asset policy schema must be uo-godot-asset-policy/1");
  }
  const allowed = new Set([
    "schema",
    "max_total_bytes",
    "max_meshes",
    "max_primitives",
    "max_materials",
    "max_textures",
    "max_image_dimension",
    "require_godot_import",
    "require_collision_nodes",
  ]);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) throw new Error(`Asset policy contains unknown field: ${key}`);
  }
  const numericKeys = [
    "max_total_bytes",
    "max_meshes",
    "max_primitives",
    "max_materials",
    "max_textures",
    "max_image_dimension",
  ] as const;
  for (const key of numericKeys) {
    const value = parsed[key];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    ) {
      throw new Error(`Asset policy ${key} must be a non-negative safe integer`);
    }
  }
  if (
    parsed.max_total_bytes !== undefined &&
    typeof parsed.max_total_bytes === "number" &&
    parsed.max_total_bytes > MAX_ASSET_TOTAL_BYTES
  ) {
    throw new Error("Asset policy max_total_bytes cannot raise the built-in limit");
  }
  for (const key of ["require_godot_import", "require_collision_nodes"] as const) {
    if (parsed[key] !== undefined && typeof parsed[key] !== "boolean") {
      throw new Error(`Asset policy ${key} must be boolean`);
    }
  }
  if (parsed.require_collision_nodes === true && parsed.require_godot_import !== true) {
    throw new Error("Asset policy collision evidence requires Godot import");
  }
  return parsed as unknown as AssetPolicyV1;
}

function applyPolicy(
  policy: AssetPolicyV1,
  metrics: AssetMetrics,
  images: AssetImageMetadata[],
  totalBytes: number,
  requestedImport: boolean,
  findings: AssetFinding[]
): boolean {
  const checks: Array<[keyof AssetPolicyV1, number]> = [
    ["max_total_bytes", totalBytes],
    ["max_meshes", metrics.meshes],
    ["max_primitives", metrics.primitives],
    ["max_materials", metrics.materials],
    ["max_textures", metrics.textures],
  ];
  for (const [key, actual] of checks) {
    const limit = policy[key];
    if (typeof limit === "number" && actual > limit) {
      findings.push({
        severity: "error",
        code: "ASSET_POLICY_LIMIT",
        location: `/policy/${key}`,
        message: `${key} limit ${limit} was exceeded by measured value ${actual}`,
      });
    }
  }
  if (typeof policy.max_image_dimension === "number") {
    for (const [index, image] of images.entries()) {
      if (
        (image.width !== null && image.width > policy.max_image_dimension) ||
        (image.height !== null && image.height > policy.max_image_dimension)
      ) {
        findings.push({
          severity: "error",
          code: "ASSET_POLICY_LIMIT",
          location: `/images/${index}`,
          message: `Image dimension exceeds policy limit ${policy.max_image_dimension}`,
        });
      }
    }
  }
  if (policy.require_godot_import === true && !requestedImport) {
    findings.push({
      severity: "error",
      code: "ASSET_POLICY_REQUIRES_IMPORT",
      location: "/policy/require_godot_import",
      message: "Asset policy requires an explicitly requested Godot import proof",
    });
  }
  return !findings.some(
    (finding) => finding.severity === "error" && finding.code.startsWith("ASSET_POLICY")
  );
}

function findingFromError(error: unknown, format: "gltf" | "glb"): AssetFinding {
  return {
    severity: "error",
    code: format === "glb" ? "ASSET_GLB_INVALID" : "ASSET_GLTF_INVALID",
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
  let images: AssetImageMetadata[] = [];
  let policyReport: AssetValidationReport["policy"] = null;
  let loadedPolicy: AssetPolicyV1 | null = null;
  let godotImportProof: AssetValidationReport["proof"]["godotImport"] = {
    status: "not_requested",
    complete: false,
  };
  let closure: InternalClosureFile[] = [
    { ...rootClosure, absolutePath: resolved.absolutePath },
  ];

  try {
    const bytes = await fs.readFile(resolved.absolutePath);
    const gltf = resolved.format === "glb" ? parseGlb(bytes) : parseGltf(bytes);
    metrics = collectMetrics(gltf);
    validateReferences(gltf, findings);
    closure = await collectClosure(
      discovery.projectRoot,
      resolved,
      beforeSha256,
      gltf,
      findings
    );
    images = await collectImageMetadata(
      discovery.projectRoot,
      resolved,
      gltf,
      closure,
      findings
    );
    if (options.policy !== undefined) {
      try {
        const policy = await loadPolicy(discovery.projectRoot, options.policy);
        loadedPolicy = policy;
        const passed = applyPolicy(
          policy,
          metrics,
          images,
          closure.reduce((sum, file) => sum + file.bytes, 0),
          options.godotImport === true,
          findings
        );
        policyReport = {
          resourcePath: options.policy,
          schema: "uo-godot-asset-policy/1",
          passed,
        };
      } catch (error) {
        findings.push({
          severity: "error",
          code: "ASSET_POLICY_INVALID",
          location: options.policy,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    findings.push(findingFromError(error, resolved.format));
  }

  const staticValid = findings.every((finding) => finding.severity !== "error");
  if (options.godotImport === true) {
    if (findings.some((finding) => finding.severity === "error")) {
      findings.push({
        severity: "error",
        code: "ASSET_IMPORT_FAILED",
        location: resolved.resourcePath,
        message: "Godot import was not run because static validation failed",
      });
      godotImportProof = { status: "error", complete: false, summary: null };
    } else {
      const imported = await runIsolatedGodotImport({
        projectRoot: discovery.projectRoot,
        asset: resolved.resourcePath,
        closure: closure.map(({ absolutePath: _absolutePath, ...file }) => file),
        godot: options.godot,
        timeoutMs: options.timeoutMs ?? 30_000,
        env,
      });
      findings.push(...imported.findings);
      godotImportProof = {
        status: imported.status,
        complete: imported.complete,
        summary: imported.summary,
        exitCodes: imported.exitCodes,
        logs: imported.logs,
        cleanup: imported.cleanup,
      };
      if (
        loadedPolicy?.require_collision_nodes === true &&
        (imported.summary?.collisionShapes ?? 0) === 0
      ) {
        findings.push({
          severity: "error",
          code: "ASSET_COLLISION_REQUIRED",
          location: "/policy/require_collision_nodes",
          message: "Godot import observed no CollisionShape3D nodes",
        });
        if (policyReport !== null) policyReport.passed = false;
      }
    }
  }

  let unchanged = true;
  for (const file of closure) {
    const afterStat = await fs.lstat(file.absolutePath);
    const afterSha256 = await sha256File(file.absolutePath);
    if (
      !afterStat.isFile() ||
      afterStat.isSymbolicLink() ||
      afterStat.size !== file.bytes ||
      afterSha256 !== file.sha256
    ) {
      unchanged = false;
      break;
    }
  }
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
  const complete =
    unchanged &&
    (options.godotImport !== true || godotImportProof.complete);
  return {
    status: valid && complete ? "ok" : "error",
    valid,
    complete,
    asset: resolved.resourcePath,
    projectRoot: discovery.projectRoot,
    format: resolved.format,
    proof: {
      static: { status: staticValid ? "ok" : "error", complete: true },
      godotImport: godotImportProof,
    },
    closure: {
      fileCount: closure.length,
      totalBytes: closure.reduce((sum, file) => sum + file.bytes, 0),
      files: closure.map(({ absolutePath: _absolutePath, ...file }) => file),
    },
    metrics,
    images,
    evidence: {
      lod: {
        status: "unknown",
        reason: "LOD evidence requires a future versioned policy rule",
      },
      collision: {
        status:
          (godotImportProof.summary?.collisionShapes ?? 0) > 0
            ? "observed"
            : "unknown",
        collisionShapes: godotImportProof.summary?.collisionShapes ?? null,
        reason:
          (godotImportProof.summary?.collisionShapes ?? 0) > 0
            ? "Collision nodes were observed; collision quality is not proven"
            : "Static glTF validation cannot prove Godot collision nodes",
      },
    },
    policy: policyReport,
    findings: findings.slice(0, MAX_ASSET_FINDINGS),
    integrity: { unchanged },
    boundaries: [BOUNDARY],
  };
}
