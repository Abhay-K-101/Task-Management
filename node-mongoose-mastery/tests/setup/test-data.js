import Task from '../../src/models/task.model.js';

// A minimal valid create payload, with overrides for whichever field a test
// actually cares about. Keeps individual tests focused on the one field
// they're exercising instead of repeating the full shape everywhere.
export function buildTaskPayload(overrides = {}) {
  return {
    title: 'Sample task',
    ...overrides,
  };
}

// Inserts tasks through the real Mongoose model (schema defaults and
// validation apply), sequentially, for tests that need real, persisted
// documents but do not care about exact createdAt ordering — filtering,
// search and pagination tests. Returns the created documents in insertion
// order.
//
// Phase 5: `owner` is now a required schema field, so an ownerId must be
// supplied. It is a required argument rather than an optional one with a
// default precisely so that a seeding call cannot silently create tasks
// belonging to nobody — the same reasoning as the repository's explicit
// ownerId parameter.
export async function seedTasks(taskInputs, ownerId) {
  if (!ownerId) {
    throw new Error('seedTasks requires an ownerId');
  }
  const created = [];
  for (const input of taskInputs) {
    created.push(await Task.create({ ...input, owner: ownerId }));
  }
  return created;
}

// Inserts tasks with explicit, caller-controlled createdAt/updatedAt values,
// bypassing Mongoose's automatic timestamp­ing by writing through the native
// driver collection. Used only by sort-order tests, so that "oldest first" /
// "newest first" assertions are deterministic and never depend on how fast
// the test machine happens to run — no sleeps, no flaky millisecond races.
export async function seedTasksWithTimestamps(taskInputs, ownerId) {
  if (!ownerId) {
    throw new Error('seedTasksWithTimestamps requires an ownerId');
  }
  const now = Date.now();
  const docs = taskInputs.map((input, index) => ({
    title: 'Sample task',
    description: '',
    completed: false,
    priority: 'medium',
    status: 'todo',
    ...input,
    // Written through the native driver below, which does no Mongoose
    // casting — so this must already be a real ObjectId, not a string.
    owner: ownerId,
    // Spaced a full minute apart so ordering is unambiguous regardless of
    // machine speed, insertion order, or index construction.
    createdAt: input.createdAt ?? new Date(now + index * 60_000),
    updatedAt: input.updatedAt ?? new Date(now + index * 60_000),
  }));
  await Task.collection.insertMany(docs);
  return docs;
}

// A small, deterministic dataset covering every filter/search dimension used
// by the GET /api/tasks test matrix: a mix of completed/status/priority
// combinations, and titles chosen so search tests have predictable partial
// and case-insensitive matches.
//
// `completed` is spelled out explicitly and kept consistent with `status`
// on every row. seedTasks() inserts through the Mongoose model directly, not
// through task.service.js, so the completed/status reconciliation logic
// never runs here — leaving `completed` to its schema default would let
// seed data silently violate the very invariant these tests check for.
export const FILTER_SEED = [
  { title: 'Write unit tests', priority: 'low', status: 'todo', completed: false },
  { title: 'Refactor auth module', priority: 'high', status: 'in-progress', completed: false },
  { title: 'Deploy node service', priority: 'high', status: 'done', completed: true },
  { title: 'Update documentation', priority: 'medium', status: 'todo', completed: false },
  { title: 'Investigate node memory leak', priority: 'high', status: 'todo', completed: false },
];
