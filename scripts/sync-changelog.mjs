#!/usr/bin/env node

const REPO = 't8y2/dbx';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const OUT_CN = 'releases-cn.json';
const OUT_EN = 'releases-en.json';

const SECTION_MAP = {
  '新功能': 'added',
  'Added': 'added',
  '改进': 'improved',
  'Improved': 'improved',
  '修复': 'fixed',
  'Fixed': 'fixed',
  '变更': 'changed',
  'Changed': 'changed',
  '移除': 'removed',
  'Removed': 'removed',
};

async function fetchAllReleases() {
  const releases = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.length === 0) break;
    releases.push(...data);
    page++;
  }
  return releases;
}

function stripDownloadSection(body) {
  const markers = ['### 下载安装', '### Download', '### 系统要求', '### System Requirements'];
  let idx = body.length;
  for (const m of markers) {
    const i = body.indexOf(m);
    if (i !== -1 && i < idx) idx = i;
  }
  return body.slice(0, idx).trim();
}

function parseBody(body) {
  const cleaned = stripDownloadSection(body);
  const sections = [];
  let current = null;

  for (const line of cleaned.split('\n')) {
    const headerMatch = line.match(/^###\s+(.+)/);
    if (headerMatch) {
      const title = headerMatch[1].trim();
      const type = SECTION_MAP[title] || 'other';
      current = { type, title, items: [] };
      sections.push(current);
      continue;
    }

    if (!current) continue;

    const itemMatch = line.match(/^-\s+\*\*(.+?)\*\*\s*[—–-]\s*(.+)/);
    if (itemMatch) {
      current.items.push({ title: itemMatch[1].trim(), desc: itemMatch[2].trim() });
      continue;
    }

    const plainMatch = line.match(/^-\s+(.+)/);
    if (plainMatch) {
      current.items.push({ title: plainMatch[1].trim(), desc: '' });
    }
  }

  return sections.filter((s) => s.items.length > 0);
}

function buildReleasesJson(releases) {
  return {
    updatedAt: new Date().toISOString(),
    releases: releases
      .filter((r) => !r.draft && !r.prerelease)
      .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
      .map((r) => ({
        tag: r.tag_name,
        name: r.name || r.tag_name,
        date: r.published_at.slice(0, 10),
        sections: parseBody(r.body || ''),
      })),
  };
}

async function translateToEnglish(cnJson) {
  if (!DEEPSEEK_API_KEY) {
    console.warn('DEEPSEEK_API_KEY not set, skipping translation');
    return null;
  }

  const enReleases = [];

  for (const release of cnJson.releases) {
    const sectionsText = release.sections
      .map((s) => {
        const items = s.items.map((i) => (i.desc ? `- **${i.title}** — ${i.desc}` : `- ${i.title}`)).join('\n');
        return `### ${s.title}\n${items}`;
      })
      .join('\n\n');

    if (!sectionsText.trim()) {
      enReleases.push({ ...release, sections: [] });
      continue;
    }

    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content:
              'You are a technical translator. Translate the following Chinese software changelog to English. Keep the exact markdown format (### headers, - bullet points, **bold** titles, — dashes). Only translate, do not add or remove content. Keep technical terms, product names, and contributor names unchanged.',
          },
          { role: 'user', content: sectionsText },
        ],
        temperature: 0.1,
      }),
    });

    if (!res.ok) {
      console.error(`DeepSeek API error for ${release.tag}: ${res.status}`);
      enReleases.push(release);
      continue;
    }

    const data = await res.json();
    const translated = data.choices?.[0]?.message?.content || '';
    const enSections = parseBody(translated);
    enReleases.push({ ...release, sections: enSections.length > 0 ? enSections : release.sections });

    await new Promise((r) => setTimeout(r, 200));
  }

  return { updatedAt: cnJson.updatedAt, releases: enReleases };
}

async function main() {
  console.log('Fetching releases from GitHub...');
  const releases = await fetchAllReleases();
  console.log(`Found ${releases.length} releases`);

  const cnJson = buildReleasesJson(releases);
  console.log(`Processed ${cnJson.releases.length} non-draft releases`);

  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUT_CN, JSON.stringify(cnJson, null, 2));
  console.log(`Wrote ${OUT_CN}`);

  console.log('Translating to English...');
  const enJson = await translateToEnglish(cnJson);
  if (enJson) {
    writeFileSync(OUT_EN, JSON.stringify(enJson, null, 2));
    console.log(`Wrote ${OUT_EN}`);
  }

  console.log('Done!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
