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
          'You suggest topics for 30–55 second dark, documentary-style YouTube Shorts. Reply with exactly 15 topics, one per line, no numbering, no extra text. Put TRENDING and currently viral topics at the very top (e.g. Epstein files, major recent revelations, widely discussed documentaries or news). Then mix in: true crime, disappearances, creepy, scary, and unthinkable/crazy. Each topic must have enough concrete beats for a gripping 30–55 second narration.'
      },
      {
        role: 'user',
        content: `Suggest 15 dark, real-life topic ideas for a 30–55 second YouTube Short. Put TRENDING / viral / currently discussed topics FIRST (e.g. Epstein files, big recent news). Then include a mix: true crime, unsolved mystery, creepy, scary, unthinkable/crazy. Real people and events only. One topic per line, format: "Short title (optional brief context)". Do not suggest only murders or disappearances. ${avoid ? '\n' + avoid + '\n' : ''}`
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

async function main() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

  let allSuggested: string[] = [];
  let currentBatch: string[] = [];

  while (true) {
    console.log('\nFetching 15 topics (trending / widely discussed first)...\n');
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
