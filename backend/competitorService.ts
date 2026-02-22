import OpenAI from 'openai';

type CompetitorVideo = {
  channelId: string;
  channelTitle: string;
  videoId: string;
  title: string;
  publishedAt: string;
  duration: string;
  viewCount: number;
};

type CompetitorChannelSummary = {
  input: string;
  channelId: string;
  channelTitle: string;
  uploads: CompetitorVideo[];
};

export type CompetitorAnalysisResult = {
  channels: CompetitorChannelSummary[];
  aggregate: {
    totalChannels: number;
    totalVideos: number;
  };
  insights: {
    topTopics: string[];
    titlePatterns: string[];
    postingPatterns: string[];
    opportunities: string[];
    suggestedIdeas: string[];
    shortSuggestions: string[];
    longVideoSuggestions: string[];
  };
};

export type DiscoveredChannel = {
  channelId: string;
  channelTitle: string;
  handle?: string;
  description?: string;
  subscriberCount?: number;
};

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY?.trim();
const OPENAI_KEY = process.env.OPENAI_API_KEY?.trim();
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

function parseChannelInput(input: string): { kind: 'id' | 'handle'; value: string } {
  const raw = input.trim();
  const normalized = raw
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?youtube\.com\//i, '')
    .replace(/^m\.youtube\.com\//i, '')
    .replace(/\/+$/, '');
  const channelMatch = normalized.match(/^channel\/(UC[\w-]{20,})/i);
  if (channelMatch) return { kind: 'id', value: channelMatch[1] };
  if (/^UC[\w-]{20,}$/i.test(raw)) return { kind: 'id', value: raw };
  const handleMatch = normalized.match(/^@([\w.-]+)/);
  if (handleMatch) return { kind: 'handle', value: handleMatch[1] };
  if (raw.startsWith('@')) return { kind: 'handle', value: raw.slice(1) };
  return { kind: 'handle', value: raw };
}

async function ytJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube API error ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

async function resolveChannel(input: string): Promise<{ channelId: string; channelTitle: string; uploadsPlaylistId: string }> {
  if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is missing');
  const parsed = parseChannelInput(input);
  let url = '';
  if (parsed.kind === 'id') {
    url = `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&id=${encodeURIComponent(parsed.value)}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
  } else {
    url = `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&forHandle=${encodeURIComponent(parsed.value)}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
  }
  const data = await ytJson<{ items?: Array<{ id?: string; snippet?: { title?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }> }>(url);
  const item = data.items?.[0];
  const channelId = item?.id;
  const channelTitle = item?.snippet?.title;
  const uploadsPlaylistId = item?.contentDetails?.relatedPlaylists?.uploads;
  if (!channelId || !channelTitle || !uploadsPlaylistId) {
    throw new Error(`Could not resolve channel: ${input}`);
  }
  return { channelId, channelTitle, uploadsPlaylistId };
}

async function getRecentVideos(uploadsPlaylistId: string, maxPerChannel: number): Promise<Array<{ videoId: string; publishedAt: string }>> {
  if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is missing');
  const out: Array<{ videoId: string; publishedAt: string }> = [];
  let pageToken = '';
  while (out.length < maxPerChannel) {
    const toFetch = Math.min(50, maxPerChannel - out.length);
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${encodeURIComponent(uploadsPlaylistId)}&maxResults=${toFetch}&pageToken=${encodeURIComponent(pageToken)}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
    const data = await ytJson<{
      nextPageToken?: string;
      items?: Array<{ snippet?: { publishedAt?: string; resourceId?: { videoId?: string } } }>;
    }>(url);
    const items = data.items ?? [];
    for (const item of items) {
      const videoId = item.snippet?.resourceId?.videoId;
      const publishedAt = item.snippet?.publishedAt;
      if (videoId && publishedAt) out.push({ videoId, publishedAt });
      if (out.length >= maxPerChannel) break;
    }
    if (!data.nextPageToken || items.length === 0) break;
    pageToken = data.nextPageToken;
  }
  return out;
}

async function getVideoDetails(videoIds: string[]): Promise<Map<string, { title: string; channelId: string; channelTitle: string; duration: string; viewCount: number }>> {
  if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is missing');
  const map = new Map<string, { title: string; channelId: string; channelTitle: string; duration: string; viewCount: number }>();
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${encodeURIComponent(chunk.join(','))}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
    const data = await ytJson<{
      items?: Array<{
        id?: string;
        snippet?: { title?: string; channelId?: string; channelTitle?: string };
        contentDetails?: { duration?: string };
        statistics?: { viewCount?: string };
      }>;
    }>(url);
    for (const item of data.items ?? []) {
      const id = item.id;
      if (!id) continue;
      map.set(id, {
        title: item.snippet?.title ?? '',
        channelId: item.snippet?.channelId ?? '',
        channelTitle: item.snippet?.channelTitle ?? '',
        duration: item.contentDetails?.duration ?? '',
        viewCount: parseInt(item.statistics?.viewCount ?? '0', 10) || 0
      });
    }
  }
  return map;
}

export async function discoverChannelsByTheme(theme: string, maxResults = 12, minSubscribers = 10000): Promise<DiscoveredChannel[]> {
  if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is required for competitor discovery');
  const q = theme.trim();
  if (!q) return [];
  const limit = Math.max(3, Math.min(20, maxResults));
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(q)}&maxResults=${limit}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
  const searchData = await ytJson<{
    items?: Array<{
      id?: { channelId?: string };
      snippet?: { title?: string; description?: string; customUrl?: string };
    }>;
  }>(searchUrl);
  const initial = (searchData.items ?? [])
    .map((it) => ({
      channelId: it.id?.channelId ?? '',
      channelTitle: it.snippet?.title ?? '',
      description: it.snippet?.description ?? '',
      handle: it.snippet?.customUrl ?? undefined
    }))
    .filter((c) => c.channelId && c.channelTitle);
  const uniqueIds = Array.from(new Set(initial.map((c) => c.channelId)));
  if (!uniqueIds.length) return [];

  const chUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${encodeURIComponent(uniqueIds.join(','))}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
  const chData = await ytJson<{
    items?: Array<{
      id?: string;
      snippet?: { title?: string; description?: string; customUrl?: string };
      statistics?: { subscriberCount?: string };
    }>;
  }>(chUrl);
  const byId = new Map<string, DiscoveredChannel>();
  for (const it of chData.items ?? []) {
    const id = it.id;
    if (!id) continue;
    const subs = parseInt(it.statistics?.subscriberCount ?? '0', 10) || 0;
    if (subs < Math.max(0, minSubscribers)) continue;
    byId.set(id, {
      channelId: id,
      channelTitle: it.snippet?.title ?? '',
      description: it.snippet?.description ?? '',
      handle: it.snippet?.customUrl ?? undefined,
      subscriberCount: subs
    });
  }
  return uniqueIds
    .map((id) => byId.get(id))
    .filter((v): v is DiscoveredChannel => !!v)
    .slice(0, limit);
}

function fallbackInsights(channels: CompetitorChannelSummary[]): CompetitorAnalysisResult['insights'] {
  const allTitles = channels.flatMap((c) => c.uploads.map((v) => v.title));
  const topWords = new Map<string, number>();
  for (const t of allTitles) {
    t.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4)
      .forEach((w) => topWords.set(w, (topWords.get(w) ?? 0) + 1));
  }
  const sorted = Array.from(topWords.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
  return {
    topTopics: sorted.map((w) => `Frequent keyword: ${w}`),
    titlePatterns: ['Many titles use curiosity hooks and concrete nouns.'],
    postingPatterns: ['Review publish times in your timezone from the competitor list below.'],
    opportunities: ['Cover adjacent stories with stronger “why it matters now” angle.'],
    suggestedIdeas: sorted.slice(0, 5).map((w) => `The strange true story behind "${w}"`),
    shortSuggestions: sorted.slice(0, 6).map((w) => `35-45s short: ${w} in one shocking twist`),
    longVideoSuggestions: sorted.slice(0, 6).map((w) => `5-11 min deep dive: full timeline and consequences of ${w}`)
  };
}

async function generateInsights(channels: CompetitorChannelSummary[]): Promise<CompetitorAnalysisResult['insights']> {
  if (!openai) return fallbackInsights(channels);
  const compact = channels.map((c) => ({
    channel: c.channelTitle,
    videos: c.uploads.slice(0, 25).map((v) => ({
      title: v.title,
      publishedAt: v.publishedAt,
      duration: v.duration,
      viewCount: v.viewCount
    }))
  }));
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'You are a YouTube competitor analyst. Return concise actionable patterns only.'
      },
      {
        role: 'user',
        content: `Analyze these competitor uploads and return JSON with keys:
- topTopics (max 8)
- titlePatterns (max 8)
- postingPatterns (max 6)
- opportunities (max 6)
- suggestedIdeas (max 8)
- shortSuggestions (max 8): ideas optimized for 35-45 second shorts
- longVideoSuggestions (max 8): ideas optimized for 5-11 minute videos

${JSON.stringify(compact)}`
      }
    ]
  });
  const text = completion.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(text) as Partial<CompetitorAnalysisResult['insights']>;
  return {
    topTopics: Array.isArray(parsed.topTopics) ? parsed.topTopics.slice(0, 8).map(String) : [],
    titlePatterns: Array.isArray(parsed.titlePatterns) ? parsed.titlePatterns.slice(0, 8).map(String) : [],
    postingPatterns: Array.isArray(parsed.postingPatterns) ? parsed.postingPatterns.slice(0, 6).map(String) : [],
    opportunities: Array.isArray(parsed.opportunities) ? parsed.opportunities.slice(0, 6).map(String) : [],
    suggestedIdeas: Array.isArray(parsed.suggestedIdeas) ? parsed.suggestedIdeas.slice(0, 8).map(String) : [],
    shortSuggestions: Array.isArray(parsed.shortSuggestions) ? parsed.shortSuggestions.slice(0, 8).map(String) : [],
    longVideoSuggestions: Array.isArray(parsed.longVideoSuggestions) ? parsed.longVideoSuggestions.slice(0, 8).map(String) : []
  };
}

export async function analyzeCompetitorChannels(inputs: string[], maxPerChannel = 20): Promise<CompetitorAnalysisResult> {
  if (!YOUTUBE_API_KEY) {
    throw new Error('YOUTUBE_API_KEY is required for competitor analysis');
  }
  const normalizedInputs = Array.from(new Set(inputs.map((x) => x.trim()).filter(Boolean))).slice(0, 10);
  if (normalizedInputs.length === 0) {
    return {
      channels: [],
      aggregate: { totalChannels: 0, totalVideos: 0 },
      insights: {
        topTopics: [],
        titlePatterns: [],
        postingPatterns: [],
        opportunities: [],
        suggestedIdeas: [],
        shortSuggestions: [],
        longVideoSuggestions: []
      }
    };
  }
  const summaries: CompetitorChannelSummary[] = [];
  for (const input of normalizedInputs) {
    const resolved = await resolveChannel(input);
    const recents = await getRecentVideos(resolved.uploadsPlaylistId, Math.max(1, Math.min(50, maxPerChannel)));
    const details = await getVideoDetails(recents.map((r) => r.videoId));
    const uploads: CompetitorVideo[] = recents
      .map((r) => {
        const d = details.get(r.videoId);
        if (!d) return null;
        return {
          channelId: d.channelId || resolved.channelId,
          channelTitle: d.channelTitle || resolved.channelTitle,
          videoId: r.videoId,
          title: d.title,
          publishedAt: r.publishedAt,
          duration: d.duration,
          viewCount: d.viewCount
        } as CompetitorVideo;
      })
      .filter((v): v is CompetitorVideo => !!v);
    summaries.push({
      input,
      channelId: resolved.channelId,
      channelTitle: resolved.channelTitle,
      uploads
    });
  }
  const insights = await generateInsights(summaries);
  return {
    channels: summaries,
    aggregate: {
      totalChannels: summaries.length,
      totalVideos: summaries.reduce((sum, c) => sum + c.uploads.length, 0)
    },
    insights
  };
}
