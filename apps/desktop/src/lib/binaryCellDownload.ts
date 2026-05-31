import type { CellValue } from "@/lib/cellValue";
import { isTauriRuntime } from "@/lib/tauriRuntime";

export type BinaryCellDownloadMode = "binary" | "utf8" | "gbk";

export interface BinaryCellDownloadPayload {
  data: Uint8Array | string;
  mimeType: string;
  extension: string;
}

export interface BinaryCellDownloadResult {
  kind: "saved" | "browser-download" | "cancelled";
  path?: string;
  fileName?: string;
}

export const BINARY_CELL_DOWNLOAD_MODES: BinaryCellDownloadMode[] = ["binary", "utf8", "gbk"];

const HEX_VALUE_RE = /^(?:0[xX]|\\x)([0-9a-fA-F\s]+)$/;
const BINARY_TYPE_RE =
  /^(?:blob|tinyblob|mediumblob|longblob|bytea|bytes|binary|varbinary|image|raw|long\s+raw)(?:\b|\()/i;

export function parseBinaryCellHexValue(value: CellValue): Uint8Array | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(HEX_VALUE_RE);
  if (!match) return null;

  const hex = match[1].replace(/\s+/g, "");
  if (!hex || hex.length % 2 !== 0) return null;

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const parsed = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(parsed)) return null;
    bytes[i] = parsed;
  }
  return bytes;
}

export function isBinaryCellColumnType(columnType?: string): boolean {
  const type = (columnType ?? "").trim();
  return !!type && BINARY_TYPE_RE.test(type);
}

export function canDownloadBinaryCellValue(value: CellValue, columnType?: string): boolean {
  if (!parseBinaryCellHexValue(value)) return false;
  return isBinaryCellColumnType(columnType) || typeof value === "string";
}

export function binaryCellDownloadPayload(value: CellValue, mode: BinaryCellDownloadMode): BinaryCellDownloadPayload {
  const bytes = parseBinaryCellHexValue(value);
  if (!bytes) {
    throw new Error("Cell value is not a hexadecimal binary value.");
  }

  if (mode === "binary") {
    return {
      data: bytes,
      mimeType: "application/octet-stream",
      extension: "bin",
    };
  }

  const decoder = new TextDecoder(mode === "gbk" ? "gbk" : "utf-8", { fatal: false });
  return {
    data: decoder.decode(bytes),
    mimeType: "text/plain;charset=utf-8",
    extension: "txt",
  };
}

export function binaryCellDownloadFileName(options: {
  column: string;
  rowNumber: number;
  mode: BinaryCellDownloadMode;
  extension: string;
}): string {
  const column = options.column
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "_")
    .slice(0, 48);
  const safeColumn = column || "cell";
  const suffix = options.mode === "binary" ? "" : `-${options.mode}`;
  return `${safeColumn}-row-${options.rowNumber}${suffix}.${options.extension}`;
}

export async function downloadBinaryCellPayload(
  payload: BinaryCellDownloadPayload,
  fileName: string,
): Promise<BinaryCellDownloadResult> {
  if (isTauriRuntime()) {
    const [{ save }, fs] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
    const path = await save({
      defaultPath: fileName,
      filters: [{ name: payload.extension.toUpperCase(), extensions: [payload.extension] }],
    });
    if (!path) return { kind: "cancelled" };
    if (typeof payload.data === "string") {
      await fs.writeTextFile(path, payload.data);
    } else {
      await fs.writeFile(path, payload.data);
    }
    return { kind: "saved", path };
  }

  const blob = new Blob([payload.data], { type: payload.mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { kind: "browser-download", fileName };
}
