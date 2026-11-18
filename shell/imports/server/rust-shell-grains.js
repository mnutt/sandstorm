import { computeTitleFromTokenOwnerUser } from "/imports/shared/grain-title";

const LIMIT = 50;
const text = (value) => Buffer.from(String(value || "Untitled grain")).subarray(0, 160).toString();
const date = (value) => value instanceof Date && Number.isFinite(+value) ? value.toISOString() : "";

// A bounded menu projection, not a grant of access. The existing shell checks
// the sharing chain when the user follows a grain link.
export async function grainMenu(db, accountId, mainUrl) {
  const owned = await db.collections.grains.find({ userId: accountId,
    trashed: { $exists: false }, suspended: { $exists: false } }, {
    sort: { lastUsed: -1, _id: 1 }, limit: LIMIT + 1,
    fields: { title: 1, lastUsed: 1, created: 1 },
  }).fetchAsync();
  const shared = await db.collections.apiTokens.rawCollection().aggregate([
    { $match: { "owner.user.accountId": accountId, grainId: { $type: "string" },
      "owner.user.denormalizedGrainMetadata": { $exists: true },
      revoked: { $ne: true }, trashed: { $exists: false }, suspended: { $exists: false } } },
    { $sort: { created: 1, _id: 1 } },
    { $group: { _id: "$grainId", owner: { $first: "$owner.user" },
      lastUsed: { $max: { $ifNull: ["$lastUsed", "$created"] } } } },
    { $sort: { lastUsed: -1, _id: 1 } },
    { $limit: LIMIT + 1 },
  ]).toArray();
  // Suppress duplicate/self-shared entries, including owned grains in the trash.
  const selfOwned = new Set((await db.collections.grains.find({ userId: accountId,
    _id: { $in: shared.map((row) => row._id) } }, { fields: { _id: 1 } }).fetchAsync()).map((row) => row._id));
  const entry = (row, isOwned) => ({ key: row._id,
    title: text(isOwned ? row.title : computeTitleFromTokenOwnerUser(row.owner).title),
    owned: isOwned, lastUsed: date(row.lastUsed || row.created),
    href: new URL("/grain/" + encodeURIComponent(row._id), mainUrl).href,
  });
  return {
    grains: [...owned.slice(0, LIMIT).map((row) => entry(row, true)),
      ...shared.slice(0, LIMIT).filter((row) => !selfOwned.has(row._id)).map((row) => entry(row, false))]
      .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed) || a.key.localeCompare(b.key)),
    grainsLimited: owned.length > LIMIT || shared.length > LIMIT,
  };
}
