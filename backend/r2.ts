import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucketName = process.env.R2_BUCKET_NAME;

const R2_ENABLED = !!(accountId && accessKeyId && secretAccessKey && bucketName);

function getClient(): S3Client | null {
  if (!R2_ENABLED) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey }
  });
}

export function isR2Enabled(): boolean {
  return R2_ENABLED;
}

/** Key: users/<userId>/projects/<projectId>/<fileName> */
export function projectKey(userId: string, projectId: string, fileName: string): string {
  return `users/${userId}/projects/${projectId}/${fileName}`;
}

export async function uploadFile(
  key: string,
  localPath: string
): Promise<{ key: string } | null> {
  const client = getClient();
  if (!client) return null;
  const body = fs.createReadStream(localPath);
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: body
    })
  );
  return { key };
}

export async function uploadBuffer(key: string, buffer: Buffer): Promise<{ key: string } | null> {
  const client = getClient();
  if (!client) return null;
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: buffer
    })
  );
  return { key };
}

export async function downloadToFile(key: string, localPath: string): Promise<boolean> {
  const client = getClient();
  if (!client) return false;
  const res = await client.send(
    new GetObjectCommand({ Bucket: bucketName!, Key: key })
  );
  if (!res.Body) return false;
  const dir = path.dirname(localPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const out = fs.createWriteStream(localPath);
  await new Promise<void>((resolve, reject) => {
    (res.Body as Readable).pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
  });
  return true;
}

export async function fileExists(key: string): Promise<boolean> {
  const client = getClient();
  if (!client) return false;
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucketName!, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** List keys with prefix; returns key names only. */
export async function listKeys(prefix: string): Promise<string[]> {
  const client = getClient();
  if (!client) return [];
  const out: string[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName!,
        Prefix: prefix,
        ContinuationToken: continuationToken
      })
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) out.push(obj.Key);
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);
  return out;
}

/** Presigned GET URL, default 1 hour. */
export async function getPresignedUrl(key: string, expiresIn = 3600): Promise<string | null> {
  const client = getClient();
  if (!client) return null;
  const cmd = new GetObjectCommand({ Bucket: bucketName!, Key: key });
  return getSignedUrl(client, cmd, { expiresIn });
}

/** Delete a single object by key. */
export async function deleteObject(key: string): Promise<boolean> {
  const client = getClient();
  if (!client) return false;
  try {
    await client.send(
      new DeleteObjectCommand({ Bucket: bucketName!, Key: key })
    );
    return true;
  } catch {
    return false;
  }
}

/** Delete all objects under users/<userId>/projects/<projectId>/ */
export async function deleteProjectAssets(
  userId: string,
  projectId: string
): Promise<void> {
  const prefix = `users/${userId}/projects/${projectId}/`;
  const keys = await listKeys(prefix);
  for (const key of keys) {
    await deleteObject(key);
  }
}

// Read an object from R2 and parse it as JSON.
export async function getObjectJson<T = any>(key: string): Promise<T | null> {
  const client = getClient();
  if (!client) return null;
  const res = await client.send(
    new GetObjectCommand({ Bucket: bucketName!, Key: key })
  );
  if (!res.Body) return null;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    (res.Body as Readable)
      .on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      })
      .on('end', resolve)
      .on('error', reject);
  });
  try {
    const text = Buffer.concat(chunks).toString('utf-8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
