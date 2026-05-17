import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import test from "node:test";
import appPackage from "../../package.json" with { type: "json" };
import downloadLinks from "../../docs/lib/downloadLinks.ts";

const { createInstallOptions } = downloadLinks;

test("docs install links are generated from the app package version", () => {
  const options = createInstallOptions("en", appPackage.version);
  const hrefs = options.map((option) => option.href);

  assert.equal(hrefs.length, 5);
  assert.ok(hrefs.every((href) => href.includes(`/DBX_${appPackage.version}_`)));
  assert.equal(hrefs.some((href) => href.includes("0.5.9")), false);
});

test("docs landing page reads latest release data instead of hard-coding the old latest update", () => {
  const source = readFileSync("docs/app/[lang]/page.tsx", "utf8");

  assert.equal(source.includes("version: 'v0.5.4'"), false);
  assert.match(source, /LandingLatestUpdates/);
  assert.match(source, /fetchLatestReleaseInfo/);
  assert.match(source, /initialLatestRelease/);
});

test("docs install widget reads the latest release version from latest.json at runtime", () => {
  const source = readFileSync("docs/components/landing/InstallTabs.tsx", "utf8");
  const latestRelease = readFileSync("docs/lib/latestRelease.ts", "utf8");

  assert.equal(source.includes("fetchChangelog"), false);
  assert.match(source, /fetchLatestReleaseInfo/);
  assert.match(latestRelease, /latest\.json/);
});

test("homepage update badge keeps latest.json version ahead of changelog tags", () => {
  const source = readFileSync("docs/components/landing/LandingLatestUpdates.tsx", "utf8");

  assert.match(source, /Promise\.all\(\[fetchLatestReleaseInfo\(\), fetchChangelog\(lang\)\]\)/);
  assert.match(source, /releaseInfo \?\? initialLatestRelease/);
});

test("docs changelog page loads releases in the browser from R2", () => {
  const source = readFileSync("docs/app/[lang]/changelog/page.tsx", "utf8");

  assert.match(source, /initialData/);
  assert.match(source, /ChangelogRuntime/);
});

test("legacy docs changelog pages do not keep stale release entries", () => {
  const en = readFileSync("docs/content/docs/changelog.mdx", "utf8");
  const cn = readFileSync("docs/content/docs/changelog.cn.mdx", "utf8");

  assert.equal(en.includes("## v0.5.4"), false);
  assert.equal(cn.includes("## v0.5.4"), false);
  assert.match(en, /\/en\/changelog/);
  assert.match(cn, /\/cn\/changelog/);
});

test("docs deploy does not rerun just to refresh R2 changelog data", () => {
  const source = readFileSync(".github/workflows/docs.yml", "utf8");

  assert.equal(source.includes("workflow_run:"), false);
  assert.equal(source.includes("Sync Changelog to R2"), false);
});

test("changelog sync configures R2 CORS for browser runtime reads", () => {
  const workflow = readFileSync(".github/workflows/sync-changelog.yml", "utf8");
  const cors = JSON.parse(readFileSync(".github/r2-cors.json", "utf8")) as {
    CORSRules: Array<{
      AllowedMethods: string[];
      AllowedOrigins: string[];
    }>;
  };
  const rule = cors.CORSRules[0];

  assert.match(workflow, /put-bucket-cors/);
  assert.deepEqual(rule.AllowedOrigins, ["*"]);
  assert.ok(rule.AllowedMethods.includes("GET"));
  assert.ok(rule.AllowedMethods.includes("HEAD"));
});

test("changelog sync also runs after release workflow publishes with GITHUB_TOKEN", () => {
  const workflow = readFileSync(".github/workflows/sync-changelog.yml", "utf8");

  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows: \['Release'\]/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
});
