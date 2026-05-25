import { existsSync, readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import test from "node:test";

const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as {
  bundle?: { windows?: { nsis?: { installMode?: string; template?: string } } };
};
const nsisTemplate = readFileSync("src-tauri/windows/nsis/installer.nsi", "utf8");

test("Windows NSIS installer template is tracked by config", () => {
  const nsis = tauriConfig.bundle?.windows?.nsis;

  assert.equal(nsis?.installMode, "currentUser");
  assert.equal(nsis?.template, "windows/nsis/installer.nsi");
  assert.equal(existsSync(join("src-tauri", nsis.template)), true);
});

test("Windows upgrades preserve user data when reinstalling", () => {
  assert.match(nsisTemplate, /\$\{OrIf\} \$R0 = 1/);
  assert.match(nsisTemplate, /StrCpy \$R1 "\$R1 \/UPDATE"/);
  assert.match(nsisTemplate, /\$\{AndIf\} \$UpdateMode <> 1/);
});
