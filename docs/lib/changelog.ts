export type ChangelogItem = {
  title: string;
  desc: string;
};

export type ChangelogSection = {
  type: string;
  title: string;
  items: ChangelogItem[];
};

export type ChangelogRelease = {
  tag: string;
  name: string;
  date: string;
  sections: ChangelogSection[];
};

export type ChangelogData = {
  updatedAt: string;
  releases: ChangelogRelease[];
};

const BASE_URL = process.env.CHANGELOG_BASE_URL || 'https://dl.dbxio.com/changelog';

export async function fetchChangelog(lang: 'en' | 'cn'): Promise<ChangelogData> {
  const url = `${BASE_URL}/releases-${lang}.json`;

  try {
    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) {
      return { updatedAt: '', releases: [] };
    }
    return res.json() as Promise<ChangelogData>;
  } catch {
    return { updatedAt: '', releases: [] };
  }
}
