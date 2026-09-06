import { Worker } from "node:worker_threads";

export interface TemplateValidationOptions { root: string; template: string; timeoutMs?: number; expectedCatalogSha256?: string }
export interface TemplateValidationReport {
  status: "ok" | "error";
  valid: boolean;
  complete: boolean;
  template: string;
  consumerReady: boolean;
  godotValidation: "not_run";
  catalogPinVerified: boolean;
  integrity: { unchanged: boolean; files: Array<{ resource: string; sha256: string }> };
  findings: Array<{ code: string; location: string; message: string }>;
}

export function validationFailure(template: string, code: string, message: string): TemplateValidationReport {
  return { status: "error", valid: false, complete: false, template,
    consumerReady: false, godotValidation: "not_run", catalogPinVerified: false,
    integrity: { unchanged: false, files: [] },
    findings: [{ code, location: template, message: message.slice(0, 1024) }] };
}

// The parent remains responsive even while a schema compiler or regex is busy.
// This is a resource boundary, not an OS sandbox for executing user code.
export function validateTemplate(options: TemplateValidationOptions): Promise<TemplateValidationReport> {
  const pin = options.expectedCatalogSha256;
  if (pin !== undefined && (typeof pin !== "string" || !/^[0-9a-fA-F]{64}$/.test(pin))) {
    return Promise.resolve(validationFailure(options.template, "TEMPLATE_CATALOG_PIN_INVALID",
      "expectedCatalogSha256 must contain exactly 64 hexadecimal characters"));
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    return Promise.resolve(validationFailure(options.template, "TEMPLATE_LIMIT_INVALID", "timeoutMs must be an integer between 1 and 120000"));
  }
  if (options.template.length > 1024 || options.root.length > 4096) {
    return Promise.resolve(validationFailure(options.template.slice(0, 1024), "TEMPLATE_LIMIT_INVALID", "Input path length limit exceeded"));
  }
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./template-validation-worker.js", import.meta.url), {
      workerData: options, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (report: TemplateValidationReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().then(() => resolve(report));
    };
    const timer = setTimeout(() => finish(validationFailure(options.template,
      "TEMPLATE_TIMEOUT", "Template validation exceeded its time limit")), timeoutMs);
    worker.once("message", finish);
    worker.once("error", () => finish(validationFailure(options.template,
      "TEMPLATE_WORKER_FAILED", "Template validation worker failed or exceeded its memory limit")));
    worker.once("exit", () => {
      if (!settled) finish(validationFailure(options.template,
        "TEMPLATE_WORKER_FAILED", "Template validation worker exited without a report"));
    });
  });
}
