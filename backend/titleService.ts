import OpenAI from 'openai';

type ScriptScene = {
  prompt: string;
  voiceover?: string;
  duration?: number;
};

type ScriptData = {
  voiceover: string;
  scenes: ScriptScene[];
};

const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_KEY?.trim()) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('OPENAI_API_KEY must be set in production to generate title suggestions');
  }
}

const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function dedupeTitles(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const title of list) {
    const cleaned = title.trim().replace(/^["'\-•\d.)\s]+/, '').trim();
    if (!cleaned) continue;
    const key = normalizeTitle(cleaned);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

export async function suggestFreshTitles(topic: string, script: ScriptData, count = 15): Promise<string[]> {
  if (!openai) {
    throw new Error('Title suggestion unavailable: OPENAI_API_KEY is not configured');
  }

  const sceneSnippets = (script.scenes || [])
    .slice(0, 8)
    .map((s, i) => `Scene ${i + 1}: ${String(s.voiceover || s.prompt || '').slice(0, 220)}`)
    .join('\n');

  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.9,
    messages: [
      {
        role: 'system',
        content:
          'You write viral-yet-accurate YouTube Shorts titles for dark documentary stories. Return plain text only: exactly one title per line, no numbering, no markdown, no commentary.'
      },
      {
        role: 'user',
        content: `Generate exactly ${count} fresh YouTube Shorts title options for this story.
Requirements:
- Highly clickable and algorithm-friendly, but no fake claims.
- Keep each title concise (about 45-75 characters ideal for Shorts).
- Keep tone dark, documentary, suspenseful.
- Avoid repetitive wording and duplicate structures.
- Do NOT include hashtags or emojis.

Topic:
${topic}

Script voiceover:
${script.voiceover || ''}

Scene context:
${sceneSnippets}`
      }
    ]
  });

  const text = (res.choices[0]?.message?.content || '').trim();
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const deduped = dedupeTitles(lines);
  if (!deduped.length) throw new Error('No title options generated');
  return deduped.slice(0, count);
}

