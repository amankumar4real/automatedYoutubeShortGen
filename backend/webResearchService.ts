type SerperSearchResponse = {
  organic?: Array<{
    title?: string;
    link?: string;
    snippet?: string;
  }>;
};

const SERPER_API_KEY = process.env.SERPER_API_KEY?.trim();

function cleanText(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

export async function getWebResearchContext(topic: string, maxItems = 6): Promise<string> {
  if (!SERPER_API_KEY) return '';
  const q = cleanText(topic);
  if (!q) return '';
  const url = 'https://google.serper.dev/search';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': SERPER_API_KEY
    },
    body: JSON.stringify({
      q,
      num: Math.max(3, Math.min(10, maxItems))
    })
  });
  if (!res.ok) return '';
  const data = (await res.json()) as SerperSearchResponse;
  const organic = Array.isArray(data.organic) ? data.organic : [];
  const rows = organic
    .map((item) => {
      const title = cleanText(item.title ?? '');
      const snippet = cleanText(item.snippet ?? '');
      const link = cleanText(item.link ?? '');
      if (!title && !snippet) return '';
      return `- ${title}${snippet ? ` — ${snippet}` : ''}${link ? ` (${link})` : ''}`;
    })
    .filter(Boolean)
    .slice(0, maxItems);
  if (!rows.length) return '';
  return [
    'WEB RESEARCH CONTEXT (recent search results):',
    ...rows
  ].join('\n');
}

export type SearchResultItem = { title: string; snippet: string; link?: string };

export async function getTrendingSearchResults(
  query: string,
  maxItems = 10
): Promise<SearchResultItem[]> {
  if (!SERPER_API_KEY) return [];
  const q = cleanText(query);
  if (!q) return [];
  const url = 'https://google.serper.dev/search';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': SERPER_API_KEY
    },
    body: JSON.stringify({
      q,
      num: Math.max(3, Math.min(15, maxItems))
    })
  });
  if (!res.ok) return [];
  const data = (await res.json()) as SerperSearchResponse;
  const organic = Array.isArray(data.organic) ? data.organic : [];
  return organic
    .map((item) => ({
      title: cleanText(item.title ?? ''),
      snippet: cleanText(item.snippet ?? ''),
      link: item.link ? cleanText(item.link) : undefined
    }))
    .filter((item) => item.title || item.snippet)
    .slice(0, maxItems);
}
