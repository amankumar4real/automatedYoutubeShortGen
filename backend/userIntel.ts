import { ObjectId } from 'mongodb';
import { getDb, USERS_COLL, UserDoc, CompetitorIntelSnapshot } from './db';

export async function getCompetitorIntelForUser(userId: string): Promise<CompetitorIntelSnapshot | null> {
  if (!ObjectId.isValid(userId)) return null;
  const db = await getDb();
  const coll = db.collection<UserDoc>(USERS_COLL);
  const user = await coll.findOne(
    { _id: new ObjectId(userId) },
    { projection: { competitorIntel: 1 } }
  );
  return user?.competitorIntel ?? null;
}

export async function setCompetitorIntelForUser(userId: string, intel: CompetitorIntelSnapshot): Promise<void> {
  if (!ObjectId.isValid(userId)) return;
  const db = await getDb();
  const coll = db.collection<UserDoc>(USERS_COLL);
  await coll.updateOne(
    { _id: new ObjectId(userId) },
    { $set: { competitorIntel: intel } }
  );
}
