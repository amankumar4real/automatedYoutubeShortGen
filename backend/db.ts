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
  createdAt: Date;
}

export type ProjectStatus =
  | 'draft'
  | 'script_generated'
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
  finalVideoKey?: string;
  youtubeMetaKey?: string;
  requiredFiles?: string[];
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const USERS_COLL = 'users';
export const PROJECTS_COLL = 'projects';
