import assert from "node:assert/strict";
import test from "node:test";

import {
  binaryCellDownloadFileName,
  binaryCellDownloadPayload,
  canDownloadBinaryCellValue,
  isBinaryCellColumnType,
  parseBinaryCellHexValue,
} from "../../apps/desktop/src/lib/binaryCellDownload.ts";

test("parseBinaryCellHexValue accepts 0x and \\x prefixed hex values", () => {
  assert.deepEqual(Array.from(parseBinaryCellHexValue("0X48656c6c6f") ?? []), [72, 101, 108, 108, 111]);
  assert.deepEqual(Array.from(parseBinaryCellHexValue("\\x00 ff") ?? []), [0, 255]);
});

test("parseBinaryCellHexValue rejects non-hex and odd-length payloads", () => {
  assert.equal(parseBinaryCellHexValue("hello"), null);
  assert.equal(parseBinaryCellHexValue("0x123"), null);
  assert.equal(parseBinaryCellHexValue(null), null);
});

test("binary cell download detects common blob column types", () => {
  assert.equal(isBinaryCellColumnType("BLOB"), true);
  assert.equal(isBinaryCellColumnType("RAW(2000)"), true);
  assert.equal(isBinaryCellColumnType("long raw"), true);
  assert.equal(isBinaryCellColumnType("varchar"), false);
});

test("canDownloadBinaryCellValue allows displayed binary hex strings", () => {
  assert.equal(canDownloadBinaryCellValue("0x89504e47", "BLOB"), true);
  assert.equal(canDownloadBinaryCellValue("0x89504e47"), true);
  assert.equal(canDownloadBinaryCellValue("89504e47", "BLOB"), false);
});

test("binaryCellDownloadPayload builds raw and decoded payloads", () => {
  const binary = binaryCellDownloadPayload("0x4869", "binary");
  assert.equal(binary.mimeType, "application/octet-stream");
  assert.equal(binary.extension, "bin");
  assert.deepEqual(Array.from(binary.data as Uint8Array), [72, 105]);

  const text = binaryCellDownloadPayload("0x4869", "utf8");
  assert.equal(text.mimeType, "text/plain;charset=utf-8");
  assert.equal(text.extension, "txt");
  assert.equal(text.data, "Hi");
});

test("binaryCellDownloadPayload decodes GBK text bytes", () => {
  const payload = binaryCellDownloadPayload("0xd6d0cec4", "gbk");
  assert.equal(payload.data, "中文");
});

test("binaryCellDownloadFileName sanitizes column names", () => {
  assert.equal(
    binaryCellDownloadFileName({ column: "avatar/blob", rowNumber: 7, mode: "gbk", extension: "txt" }),
    "avatar-blob-row-7-gbk.txt",
  );
});
