import OpenAI from 'openai';

/**
 * Service for suggesting short topics. Supports OpenAI (GPT) or xAI (Grok) via provider param.
 */

export type TopicScriptProvider = 'openai' | 'grok';

const OPENAI_KEY = process.env.OPENAI_API_KEY?.trim();
const XAI_KEY = process.env.XAI_API_KEY?.trim();

const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;
const grokClient = XAI_KEY ? new OpenAI({ apiKey: XAI_KEY, baseURL: 'https://api.x.ai/v1' }) : null;

function getChatClient(provider: TopicScriptProvider): OpenAI | null {
  if (provider === 'grok') return grokClient;
  return openai;
}

const GROK_MODEL = 'grok-3-latest';

function normalizeTopic(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDuplicate(newTopic: string, alreadySuggested: string[]): boolean {
  const n = normalizeTopic(newTopic);
  if (!n) return true;
  return alreadySuggested.some((s) => {
    const existing = normalizeTopic(s);
    return existing === n || existing.includes(n) || n.includes(existing);
  });
}

async function fetchTopicsWithProvider(alreadySuggested: string[] = [], provider: TopicScriptProvider): Promise<string[]> {
  const client = getChatClient(provider);
  if (!client) {
    throw new Error(provider === 'grok' ? 'Topic suggestion unavailable: XAI_API_KEY is not configured' : 'Topic suggestion unavailable: OPENAI_API_KEY is not configured');
  }

  const avoid =
    alreadySuggested.length > 0
      ? `CRITICAL: The user has already seen these topics in this session. You MUST NOT suggest any topic that is the same as or substantially similar to any of these. Suggest only brand-new topics they have not seen yet:\n${alreadySuggested.slice(0, 80).join('\n')}`
      : '';

  const model = provider === 'grok' ? GROK_MODEL : 'gpt-4o';
  const res = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content:
          'You suggest topics for 30–55 second documentary-style YouTube Shorts. Reply with exactly 15 topics, one per line, no numbering, no extra text. PRIORITIZE the genuinely bizarre, absurd, mind-bending, and WTF-worthy—the kind of stories that make people say "wait, that actually happened?" Maximize VARIETY: no two topics in one batch should feel like the same subgenre back-to-back. Mix wildly: historical oddities, science gone wrong, cursed/creepy objects, internet lore, hoaxes and cons, mass hysteria, bizarre experiments, unexplained phenomena, true crime with a twist, dangerous places, paranormal claims, cults, survival horror, and anything that sounds crazy but is real. Each topic must have enough concrete beats for a gripping 30–55 second narration. Real people and events only.'
      },
      {
        role: 'user',
        content: `Suggest 15 real-life topic ideas for a 30–55 second YouTube Short. This batch must feel DIVERSE and UNPREDICTABLE.

- Go CRAZY and BIZARRE: favor the weird, the absurd, the "that can\'t be real" stories. Mix in: historical oddities, science disasters, cursed artifacts, viral hoaxes, mass delusions, bizarre experiments, unexplained phenomena, true crime with a twist, dangerous places, cults, survival stories, internet lore, and anything that makes viewers do a double-take.
- VARIETY is critical: do NOT give 5 similar true-crime topics or 5 similar "mystery" topics. Jump between eras, regions, and subgenres. Each of the 15 should feel like a different flavor.
- Format: one topic per line, e.g. "Short punchy title (optional brief context)". Real people and events only.
${avoid ? '\n' + avoid + '\n' : ''}`
      }
    ],
    temperature: 0.95
  });

  const text = (res.choices[0]?.message?.content ?? '').trim();
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^\d+[.)]\s*/, '').trim())
    .filter((l) => l.length > 0);

  const deduped = lines.filter((line) => !isDuplicate(line, alreadySuggested));
  return deduped.slice(0, 15);
}

/**
 * Public API: suggest a batch of topics.
 * @param previous Topics already seen this session.
 * @param provider 'openai' (GPT) or 'grok'. Default openai.
 */
export async function suggestTopics(previous?: string[], provider: TopicScriptProvider = 'openai'): Promise<string[]> {
  const already = Array.isArray(previous) ? previous.filter(Boolean) : [];
  return fetchTopicsWithProvider(already, provider);
}

const TRENDING_DOMAIN_SYSTEM =
  'You suggest topics for 30–55 second documentary-style YouTube Shorts. Your domain: bizarre true stories, historical oddities, science gone wrong, true crime with a twist, hoaxes and cons, mass hysteria, unexplained phenomena, cults, survival horror, internet lore, dangerous places—the kind that make people say "wait, that actually happened?" Real people and events only. Reply with exactly 15 topics, one per line, no numbering, no extra text.';

/**
 * Suggest a list of topics that are trending right now and fit the same domain.
 * @param previous Topics already seen. @param provider 'openai' or 'grok'. Default openai.
 */
export async function suggestTrendingTopics(previous?: string[], provider: TopicScriptProvider = 'openai'): Promise<string[]> {
  const { getTrendingSearchResults } = await import('./webResearchService');
  const results = await getTrendingSearchResults(
    'trending viral news stories today',
    12
  );
  const already = Array.isArray(previous) ? previous.filter(Boolean) : [];
  const avoid =
    already.length > 0
      ? `\nDo NOT suggest topics same as or very similar to these:\n${already.slice(0, 50).join('\n')}\n`
      : '';

  const client = getChatClient(provider);
  if (!client) {
    throw new Error(provider === 'grok' ? 'Trending topics unavailable: XAI_API_KEY is not configured' : 'Trending topics unavailable: OPENAI_API_KEY is not configured');
  }

  if (!results.length) {
    return fetchTopicsWithProvider(already, provider).then((t) => t.slice(0, 15));
  }

  const searchContext = results
    .map((r) => `- ${r.title}${r.snippet ? ` — ${r.snippet}` : ''}`)
    .join('\n');

  const model = provider === 'grok' ? GROK_MODEL : 'gpt-4o';
  const res = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: TRENDING_DOMAIN_SYSTEM
      },
      {
        role: 'user',
        content: `Here are current trending search results. Pick 15 topics that are BOTH trending right now AND fit our domain (bizarre true stories, documentary shorts, true crime, mysteries, weird history, viral hoaxes, etc.). Prefer topics that appear in or relate to these results. Real events/people only. Format: one topic per line, e.g. "Short punchy title (optional context)".${avoid}\n\nTrending context:\n${searchContext}`
      }
    ],
    temperature: 0.85
  });

  const text = (res.choices[0]?.message?.content ?? '').trim();
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^\d+[.)]\s*/, '').trim())
    .filter((l) => l.length > 0);
  const deduped = lines.filter((line) => !isDuplicate(line, already));
  return deduped.slice(0, 15);
}

