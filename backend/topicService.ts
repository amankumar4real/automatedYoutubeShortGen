import OpenAI from 'openai';

/**
 * Service for suggesting short topics, based on the standalone get_topic.ts script.
 */

const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_KEY?.trim()) {
  // In production it's better to fail fast if this feature is expected.
  // In dev, the route will surface a clear 503 when called.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('OPENAI_API_KEY must be set in production to use topic suggestions');
  }
}

const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

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

async function fetchTopics(alreadySuggested: string[] = []): Promise<string[]> {
  if (!openai) {
    throw new Error('Topic suggestion unavailable: OPENAI_API_KEY is not configured');
  }

  const avoid =
    alreadySuggested.length > 0
      ? `CRITICAL: The user has already seen these topics in this session. You MUST NOT suggest any topic that is the same as or substantially similar to any of these. Suggest only brand-new topics they have not seen yet:\n${alreadySuggested.slice(0, 80).join('\n')}`
      : '';

  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content:
          'You suggest topics for 30–55 second dark, documentary-style YouTube Shorts. Reply with exactly 15 topics, one per line, no numbering, no extra text. Put TRENDING and currently viral topics at the very top (e.g. Epstein files, major recent revelations, widely discussed documentaries or news, topics dominating social media). Then mix in: true crime, disappearances, creepy (cursed objects, disturbing discoveries, stalkers, unexplained phenomena), scary (paranormal, survival horror, dangerous places), and unthinkable/crazy (cults, mass hysteria, bizarre experiments, hoaxes gone wrong). Each topic must have enough concrete beats for a gripping 30–55 second narration.'
      },
      {
        role: 'user',
        content: `Suggest 15 dark, real-life topic ideas for a 30–55 second YouTube Short.
- Put TRENDING / viral / currently discussed topics FIRST (e.g. Epstein files, big recent news, widely discussed cases).
- Then include a mix: true crime, unsolved mystery, creepy (cursed objects, stalkers, unexplained phenomena), scary (paranormal, survival horror, dangerous places), unthinkable/crazy (cults, mass hysteria, bizarre experiments, hoaxes gone wrong).

Real people and events only. One topic per line, format: "Short title (optional brief context)". Do not suggest only murders or disappearances.
${avoid ? '\n' + avoid + '\n' : ''}`
      }
    ],
    temperature: 0.85
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
 *
 * @param previous A list of topics the client has already seen, used to reduce repeats.
 */
export async function suggestTopics(previous?: string[]): Promise<string[]> {
  const already = Array.isArray(previous) ? previous.filter(Boolean) : [];
  return fetchTopics(already);
}

