import { MongoClient, Db } from 'mongodb';
import { config } from './config';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (db) return db;
  client = new MongoClient(config.mongodb.uri);
  await client.connect();
  db = client.db(config.mongodb.dbName);
  await db.collection(USERS_COLL).createIndex({ username: 1 }, { unique: true }).catch(() => {});
  await db.collection(PROJECTS_COLL).createIndex({ projectId: 1 }, { unique: true }).catch(() => {});
  await db.collection(PROJECTS_COLL).createIndex({ userId: 1, idempotencyKey: 1 }).catch(() => {});
  return db;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

export interface UserDoc {
  _id: import('mongodb').ObjectId;
  username: string;
  passwordHash: string;
  competitorIntel?: CompetitorIntelSnapshot;
  createdAt: Date;
}

export interface CompetitorIntelSnapshot {
  updatedAt: string;
  channels: Array<{
    input: string;
    channelId: string;
    channelTitle: string;
    uploads: Array<{
      videoId: string;
      title: string;
      publishedAt: string;
      duration: string;
      viewCount: number;
    }>;
  }>;
  insights: {
    topTopics: string[];
    titlePatterns: string[];
    postingPatterns: string[];
    opportunities: string[];
    suggestedIdeas: string[];
    shortSuggestions?: string[];
    longVideoSuggestions?: string[];
  };
}

export type ProjectStatus =
  | 'draft'
  | 'script_generated'
  | 'rejected'
  | 'audio_generated'
  | 'waiting_for_clips'
  | 'assembly_done'
  | 'error';

export interface StageEntry {
  stage: string;
  status: string;
  at: string;
  detail?: string;
}

export interface ProjectDoc {
  _id: import('mongodb').ObjectId;
  projectId: string;
  userId: import('mongodb').ObjectId;
  topic: string;
  idempotencyKey?: string;
  status: ProjectStatus;
  currentStage?: string;
  stageHistory: StageEntry[];
  scriptKey?: string;
  audioKeys?: string[];
  clipKeys?: string[];
  imageKeys?: string[];
  finalVideoKey?: string;
  youtubeMetaKey?: string;
  segmentMapKey?: string;
  segmentAlignmentKey?: string;
  /** R2 key for optional per-project background music (assembly step 4). */
  backgroundMusicKey?: string;
  /** Start background music from this many seconds into the track (0 = from start). */
  backgroundMusicStartSec?: number;
  requiredFiles?: string[];
  errorMessage?: string;
  /** Video format: short (~1 min), 5min, or 11min. Default short. */
  videoFormat?: 'short' | '5min' | '11min';
  /** Whether project script should use saved competitor intel context. */
  useCompetitorIntel?: boolean;
  /** Whether project script should include fresh web research context. */
  useWebResearch?: boolean;
  /** Provider for script (and topic if chosen at create): openai (GPT) or grok. */
  scriptProvider?: 'openai' | 'grok';
  createdAt: Date;
  updatedAt: Date;
}

export const USERS_COLL = 'users';
export const PROJECTS_COLL = 'projects';
