/**
 * Interactive topic picker for Shorts. Fetches dark, real-life topic ideas from ChatGPT
 * (true crime, unsolved mystery, unhinged/scary). Choose one or get 15 more.
 *
 * Run: npx ts-node get_topic.ts   or   npx tsc && node get_topic.js
 * Then run automate_shorts — it will use the selected topic from temp/selected_topic.txt
 *
 * Note: "Trending" here is from ChatGPT's training (widely discussed topics). For
 * real-time trending you could add Google Trends API or similar later.
 */
import 'dotenv/config';
import OpenAI from 'openai';
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const readline = require('readline') as typeof import('readline');

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const TEMP_DIR = path.resolve(process.cwd(), 'temp');
const SELECTED_TOPIC_FILE = path.join(TEMP_DIR, 'selected_topic.txt');
const USED_TOPICS_FILE = path.join(TEMP_DIR, 'used_topics.txt');
const MAX_USED_TOPICS = 200;

if (!OPENAI_KEY?.trim()) {
  console.error('Set OPENAI_API_KEY in .env');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

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

function loadUsedTopics(): string[] {
  if (!fs.existsSync(USED_TOPICS_FILE)) return [];
  const raw = fs.readFileSync(USED_TOPICS_FILE, 'utf-8').trim();
  return raw ? raw.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

function appendUsedTopic(topic: string): void {
  const t = (topic || '').trim();
  if (!t) return;
  const used = loadUsedTopics();
  if (used.some((u) => normalizeTopic(u) === normalizeTopic(t))) return;
  used.push(t);
  const toWrite = used.slice(-MAX_USED_TOPICS).join('\n') + (used.length > MAX_USED_TOPICS ? '\n' : '');
  fs.writeFileSync(USED_TOPICS_FILE, toWrite, 'utf-8');
}

async function fetchTopics(alreadySuggested: string[] = []): Promise<string[]> {
  const avoid =
    alreadySuggested.length > 0
      ? `CRITICAL: The user has already seen these topics. You MUST NOT suggest any topic that is the same as or substantially similar to any of these. Suggest only brand-new topics:\n${alreadySuggested.slice(0, 80).join('\n')}`
      : '';

  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content:
          'You suggest topics for 30–55 second documentary-style YouTube Shorts. Reply with exactly 15 topics, one per line, no numbering, no extra text. PRIORITIZE the genuinely bizarre, absurd, mind-bending, and WTF-worthy—the kind of stories that make people say "wait, that actually happened?" Maximize VARIETY: no two topics in one batch should feel like the same subgenre back-to-back. Mix wildly: historical oddities, science gone wrong, cursed/creepy objects, internet lore, hoaxes and cons, mass hysteria, bizarre experiments, unexplained phenomena, true crime with a twist, dangerous places, paranormal claims, cults, survival horror, and anything that sounds crazy but is real. Each topic must have enough concrete beats for a gripping 30–55 second narration. Real people and events only.'
      },
      {
        role: 'user',
        content: `Suggest 15 real-life topic ideas for a 30–55 second YouTube Short. This batch must feel DIVERSE and UNPREDICTABLE.

- Go CRAZY and BIZARRE: favor the weird, the absurd, the "that can't be real" stories. Mix in: historical oddities, science disasters, cursed artifacts, viral hoaxes, mass delusions, bizarre experiments, unexplained phenomena, true crime with a twist, dangerous places, cults, survival stories, internet lore, and anything that makes viewers do a double-take.
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

async function main() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

  const usedFromFile = loadUsedTopics();
  let allSuggested: string[] = [...usedFromFile];
  let currentBatch: string[] = [];

  while (true) {
    console.log('\nFetching 15 crazy / bizarre topics (varied mix)...\n');
    currentBatch = await fetchTopics(allSuggested);
    allSuggested = [...allSuggested, ...currentBatch];

    currentBatch.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
    console.log('');
    const input = await ask('Enter number (1–15) to choose, "next" for 15 more, or "q" to quit: ');
    const lower = input.toLowerCase();

    if (lower === 'q' || lower === 'quit') {
      console.log('Bye.');
      process.exit(0);
    }

    if (lower === 'next' || lower === 'n') continue;

    const num = parseInt(input, 10);
    if (num >= 1 && num <= 15) {
      const chosen = currentBatch[num - 1];
      if (!chosen) {
        console.log('Invalid number.');
        continue;
      }
      fs.writeFileSync(SELECTED_TOPIC_FILE, chosen, 'utf-8');
      appendUsedTopic(chosen);
      console.log(`\nSelected: ${chosen}`);
      console.log(`Saved to ${SELECTED_TOPIC_FILE}. Run automate_shorts and it will use this topic.\n`);
      process.exit(0);
    }

    console.log('Enter 1–15, "next", or "q".');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
