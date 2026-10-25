import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  connectTestDatabase,
  clearTestDatabase,
  disconnectTestDatabase,
} from '../setup/database.js';
import { createTestUser } from '../setup/auth.js';
import { seedTasks, seedTasksWithTimestamps, FILTER_SEED } from '../setup/test-data.js';

function list(query = '') {
  return api.get(`/api/tasks${query}`);
}

function searchQuery(term) {
  return `?search=${encodeURIComponent(term)}`;
}

function buildManyTasks(count) {
  return Array.from({ length: count }, (_, i) => ({
    title: `Pagination task ${String(i + 1).padStart(2, '0')}`,
  }));
}

// Populated in beforeEach: an authenticated request helper bound to a
// freshly created user, plus that user's id for seeding.
let api;
let ownerId;

beforeAll(async () => {
  await connectTestDatabase();
});

beforeEach(async () => {
  await clearTestDatabase();
  // A fresh authenticated user per test. clearTestDatabase() wipes the users
  // collection too, so this must run after it, not once in beforeAll.
  const auth = await createTestUser();
  api = auth.api;
  ownerId = auth.userId;
});

afterAll(async () => {
  await disconnectTestDatabase();
});

describe('GET /api/tasks — default behaviour', () => {
  it('returns 200 for an empty collection', async () => {
    const res = await list();
    expect(res.status).toBe(200);
  });

  it('returns data as an empty array for an empty collection', async () => {
    const res = await list();
    expect(res.body.data).toEqual([]);
  });

  it('defaults to page 1', async () => {
    expect((await list()).body.pagination.page).toBe(1);
  });

  it('defaults to limit 10', async () => {
    expect((await list()).body.pagination.limit).toBe(10);
  });

  it('requires neither page nor limit query parameters', async () => {
    expect((await list()).status).toBe(200);
  });

  it('uses the default limit when only page is supplied', async () => {
    expect((await list('?page=2')).body.pagination.limit).toBe(10);
  });

  it('uses the default page when only limit is supplied', async () => {
    expect((await list('?limit=5')).body.pagination.page).toBe(1);
  });

  it('defaults to sorting by createdAt descending (the approved Phase 3 contract)', async () => {
    await seedTasksWithTimestamps([{ title: 'Older' }, { title: 'Newer' }], ownerId);
    const res = await list();
    expect(res.body.data.map((t) => t.title)).toEqual(['Newer', 'Older']);
  });

  it('returns an envelope containing success, data and pagination', async () => {
    const res = await list();
    expect(res.body).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.any(Array),
        pagination: expect.any(Object),
      })
    );
  });
});

describe('GET /api/tasks — filtering', () => {
  beforeEach(async () => {
    await seedTasks(FILTER_SEED, ownerId);
  });

  it('completed=true returns only completed tasks', async () => {
    const res = await list('?completed=true');
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((t) => t.completed === true)).toBe(true);
  });

  it('completed=false returns only incomplete tasks', async () => {
    const res = await list('?completed=false');
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((t) => t.completed === false)).toBe(true);
  });

  it.each(['todo', 'in-progress', 'done'])('status=%s returns only matching tasks', async (status) => {
    const res = await list(`?status=${status}`);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((t) => t.status === status)).toBe(true);
  });

  it.each(['low', 'medium', 'high'])('priority=%s returns only matching tasks', async (priority) => {
    const res = await list(`?priority=${priority}`);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((t) => t.priority === priority)).toBe(true);
  });

  it('combines completed and priority filters', async () => {
    const res = await list('?completed=false&priority=high');
    expect(res.body.data.every((t) => t.completed === false && t.priority === 'high')).toBe(true);
  });

  it('combines status and priority filters', async () => {
    const res = await list('?status=todo&priority=high');
    expect(res.body.data.every((t) => t.status === 'todo' && t.priority === 'high')).toBe(true);
  });

  it('combines completed and status filters', async () => {
    const res = await list('?completed=true&status=done');
    expect(res.body.data.every((t) => t.completed === true && t.status === 'done')).toBe(true);
  });

  it('combines completed, status and priority filters', async () => {
    const res = await list('?completed=false&status=todo&priority=high');
    expect(
      res.body.data.every((t) => t.completed === false && t.status === 'todo' && t.priority === 'high')
    ).toBe(true);
  });

  it('returns 200 with an empty array for a valid filter with no matches', async () => {
    const res = await list('?priority=low&status=done');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it.each(['yes', '1'])('completed=%s returns 400', async (value) => {
    expect((await list(`?completed=${value}`)).status).toBe(400);
  });

  it('an invalid status returns 400', async () => {
    expect((await list('?status=archived')).status).toBe(400);
  });

  it('an invalid priority returns 400', async () => {
    expect((await list('?priority=urgent')).status).toBe(400);
  });

  it('an impossible status/completed combination returns no inconsistent documents', async () => {
    const res = await list('?status=done&completed=false');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('GET /api/tasks — search', () => {
  beforeEach(async () => {
    await seedTasks(FILTER_SEED, ownerId);
  });

  it('finds an exact-title match', async () => {
    const res = await list(searchQuery('Write unit tests'));
    expect(res.body.data.map((t) => t.title)).toContain('Write unit tests');
  });

  it('finds a partial-title match', async () => {
    const res = await list(searchQuery('node'));
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((t) => /node/i.test(t.title))).toBe(true);
  });

  it('search is case-insensitive', async () => {
    const lower = await list(searchQuery('node'));
    const upper = await list(searchQuery('NODE'));
    expect(upper.body.data.map((t) => t._id).sort()).toEqual(lower.body.data.map((t) => t._id).sort());
  });

  it('returns multiple results when several titles match', async () => {
    const res = await list(searchQuery('node'));
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('returns an empty array when nothing matches', async () => {
    const res = await list(searchQuery('nonexistent-term-xyz'));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('an empty search returns the unfiltered collection (documented as "no search")', async () => {
    const res = await list('?search=');
    expect(res.body.pagination.totalCount).toBe(FILTER_SEED.length);
  });

  it('a whitespace-only search returns the unfiltered collection', async () => {
    const res = await list(searchQuery('   '));
    expect(res.body.pagination.totalCount).toBe(FILTER_SEED.length);
  });

  it('treats a literal "." as a character, not "match anything" — proves escaping works', async () => {
    // Unescaped, /node./i would match "node " in "Deploy node service" and
    // "Investigate node memory leak" (". " matches any character). None of
    // the seeded titles contain a literal period, so a correctly escaped
    // search must match nothing.
    const res = await list(searchQuery('node.'));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('treats ".*" as literal characters, not "match everything" — proves no match explosion', async () => {
    const res = await list(searchQuery('.*'));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it.each(['.', '*', '+', '?', '(', ')', '[', ']', '^', '$'])(
    'treats the regex special character "%s" as a safe literal (no crash, no 500)',
    async (char) => {
      const res = await list(searchQuery(`node${char}db`));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toEqual([]);
    }
  );

  it('search correctly narrows totalCount, not just the current page', async () => {
    const res = await list(searchQuery('node') + '&limit=1');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.totalCount).toBe(2);
  });
});

describe('GET /api/tasks — sorting', () => {
  it('sorts by title ascending', async () => {
    await seedTasksWithTimestamps([{ title: 'Charlie' }, { title: 'Alpha' }, { title: 'Bravo' }], ownerId);
    const res = await list('?sortBy=title&order=asc');
    expect(res.body.data.map((t) => t.title)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('sorts by title descending', async () => {
    await seedTasksWithTimestamps([{ title: 'Charlie' }, { title: 'Alpha' }, { title: 'Bravo' }], ownerId);
    const res = await list('?sortBy=title&order=desc');
    expect(res.body.data.map((t) => t.title)).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('sorts by createdAt ascending', async () => {
    await seedTasksWithTimestamps([{ title: 'First' }, { title: 'Second' }, { title: 'Third' }], ownerId);
    const res = await list('?sortBy=createdAt&order=asc');
    expect(res.body.data.map((t) => t.title)).toEqual(['First', 'Second', 'Third']);
  });

  it('sorts by createdAt descending', async () => {
    await seedTasksWithTimestamps([{ title: 'First' }, { title: 'Second' }, { title: 'Third' }], ownerId);
    const res = await list('?sortBy=createdAt&order=desc');
    expect(res.body.data.map((t) => t.title)).toEqual(['Third', 'Second', 'First']);
  });

  it('sorts by updatedAt ascending', async () => {
    await seedTasksWithTimestamps([{ title: 'First' }, { title: 'Second' }, { title: 'Third' }], ownerId);
    const res = await list('?sortBy=updatedAt&order=asc');
    expect(res.body.data.map((t) => t.title)).toEqual(['First', 'Second', 'Third']);
  });

  it('sorts by updatedAt descending', async () => {
    await seedTasksWithTimestamps([{ title: 'First' }, { title: 'Second' }, { title: 'Third' }], ownerId);
    const res = await list('?sortBy=updatedAt&order=desc');
    expect(res.body.data.map((t) => t.title)).toEqual(['Third', 'Second', 'First']);
  });

  it('sorting by updatedAt is genuinely independent of createdAt order (proves sortBy is honoured)', async () => {
    const now = Date.now();
    await seedTasksWithTimestamps([
      { title: 'Created first, updated last', createdAt: new Date(now), updatedAt: new Date(now + 120_000) },
      { title: 'Created last, updated first', createdAt: new Date(now + 60_000), updatedAt: new Date(now) },
    ], ownerId);
    const res = await list('?sortBy=updatedAt&order=asc');
    expect(res.body.data.map((t) => t.title)).toEqual([
      'Created last, updated first',
      'Created first, updated last',
    ]);
  });

  it('rejects an invalid sortBy', async () => {
    expect((await list('?sortBy=notAField')).status).toBe(400);
  });

  it('rejects an invalid order', async () => {
    expect((await list('?sortBy=title&order=sideways')).status).toBe(400);
  });

  it('uses the documented default order (desc) when sortBy is present without order', async () => {
    await seedTasksWithTimestamps([{ title: 'Older' }, { title: 'Newer' }], ownerId);
    const res = await list('?sortBy=createdAt');
    expect(res.body.data.map((t) => t.title)).toEqual(['Newer', 'Older']);
  });

  it('uses the documented default sortBy (createdAt) when order is present without sortBy', async () => {
    await seedTasksWithTimestamps([{ title: 'Older' }, { title: 'Newer' }], ownerId);
    const res = await list('?order=asc');
    expect(res.body.data.map((t) => t.title)).toEqual(['Older', 'Newer']);
  });

  it('rejects a duplicated sortBy query parameter rather than forwarding an array to Mongoose', async () => {
    // Express parses repeated keys (?sortBy=title&sortBy=createdAt) as an
    // array. The service only accepts a string from a fixed allow-list, so
    // an array value fails that check and is safely rejected.
    const res = await api.get('/api/tasks').query('sortBy=title&sortBy=createdAt');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/tasks — pagination', () => {
  it('page=1 and limit=10 returns the first 10 items in order', async () => {
    await seedTasksWithTimestamps(buildManyTasks(25), ownerId);
    const res = await list('?sortBy=createdAt&order=asc&page=1&limit=10');
    expect(res.body.data).toHaveLength(10);
    expect(res.body.data[0].title).toBe('Pagination task 01');
    expect(res.body.data[9].title).toBe('Pagination task 10');
  });

  it('page=2 returns a different slice', async () => {
    await seedTasksWithTimestamps(buildManyTasks(25), ownerId);
    const res = await list('?sortBy=createdAt&order=asc&page=2&limit=10');
    expect(res.body.data[0].title).toBe('Pagination task 11');
  });

  it('returns a partial final page', async () => {
    await seedTasksWithTimestamps(buildManyTasks(25), ownerId);
    const res = await list('?sortBy=createdAt&order=asc&page=3&limit=10');
    expect(res.body.data).toHaveLength(5);
    expect(res.body.data[4].title).toBe('Pagination task 25');
  });

  it('a page beyond totalPages returns 200 with an empty data array', async () => {
    await seedTasksWithTimestamps(buildManyTasks(25), ownerId);
    const res = await list('?page=999&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.totalCount).toBe(25);
  });

  it.each(['0', '-1', '1.5', 'abc', ''])('page=%j returns 400', async (page) => {
    expect((await list(`?page=${encodeURIComponent(page)}`)).status).toBe(400);
  });

  it.each(['1', '100'])('limit=%s is accepted', async (limit) => {
    const res = await list(`?limit=${limit}`);
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(Number(limit));
  });

  it.each(['0', '-1', '101', '2.5', 'abc'])('limit=%j returns 400', async (limitValue) => {
    expect((await list(`?limit=${encodeURIComponent(limitValue)}`)).status).toBe(400);
  });

  it('totalCount represents all matching records before pagination is applied', async () => {
    await seedTasksWithTimestamps(buildManyTasks(25), ownerId);
    const res = await list('?page=1&limit=5');
    expect(res.body.pagination.totalCount).toBe(25);
  });

  it('totalPages is calculated correctly from totalCount and limit', async () => {
    await seedTasksWithTimestamps(buildManyTasks(25), ownerId);
    expect((await list('?limit=10')).body.pagination.totalPages).toBe(3);
  });

  it('hasNextPage is true while more pages remain and false on the last page', async () => {
    await seedTasksWithTimestamps(buildManyTasks(25), ownerId);
    expect((await list('?limit=10&page=1')).body.pagination.hasNextPage).toBe(true);
    expect((await list('?limit=10&page=3')).body.pagination.hasNextPage).toBe(false);
  });

  it('hasPrevPage is false on the first page and true afterwards', async () => {
    await seedTasksWithTimestamps(buildManyTasks(25), ownerId);
    expect((await list('?limit=10&page=1')).body.pagination.hasPrevPage).toBe(false);
    expect((await list('?limit=10&page=2')).body.pagination.hasPrevPage).toBe(true);
  });

  it('adjacent pages contain no duplicate documents when the dataset is unchanged', async () => {
    await seedTasksWithTimestamps(buildManyTasks(25), ownerId);
    const page1 = await list('?sortBy=createdAt&order=asc&limit=10&page=1');
    const page2 = await list('?sortBy=createdAt&order=asc&limit=10&page=2');
    const ids1 = page1.body.data.map((t) => t._id);
    const ids2 = page2.body.data.map((t) => t._id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  it('adjacent pages skip no document when the dataset is unchanged', async () => {
    await seedTasksWithTimestamps(buildManyTasks(25), ownerId);
    const pages = await Promise.all(
      [1, 2, 3].map((page) => list(`?sortBy=createdAt&order=asc&limit=10&page=${page}`))
    );
    const allTitles = pages.flatMap((res) => res.body.data.map((t) => t.title));
    expect(allTitles).toEqual(buildManyTasks(25).map((t) => t.title));
  });
});

describe('GET /api/tasks — permutations', () => {
  const PERMUTATION_SEED = [
    { title: 'Node service alpha', priority: 'high', status: 'todo', completed: false },
    { title: 'Node service beta', priority: 'high', status: 'todo', completed: false },
    { title: 'Node service gamma', priority: 'high', status: 'done', completed: true },
    { title: 'Node service delta', priority: 'low', status: 'todo', completed: false },
    { title: 'Database migration', priority: 'high', status: 'todo', completed: false },
    { title: 'Database backup', priority: 'medium', status: 'done', completed: true },
  ];

  beforeEach(async () => {
    await seedTasksWithTimestamps(PERMUTATION_SEED, ownerId);
  });

  it('filter + search', async () => {
    const res = await list(`?priority=high${searchQuery('node').replace('?', '&')}`);
    expect(res.body.data.every((t) => t.priority === 'high' && /node/i.test(t.title))).toBe(true);
    // priority=high matches alpha, beta, gamma, migration; search=node further
    // narrows to titles containing "node": alpha, beta, gamma (migration is
    // "Database migration" — no "node" in the title).
    expect(res.body.data).toHaveLength(3);
  });

  it('filter + sort', async () => {
    const res = await list('?priority=high&sortBy=title&order=asc');
    const titles = res.body.data.map((t) => t.title);
    expect(res.body.data.every((t) => t.priority === 'high')).toBe(true);
    expect(titles).toEqual([...titles].sort());
  });

  it('filter + pagination', async () => {
    const res = await list('?priority=high&limit=2&page=1');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((t) => t.priority === 'high')).toBe(true);
    expect(res.body.pagination.totalCount).toBe(4);
  });

  it('search + sort', async () => {
    const res = await list(searchQuery('node') + '&sortBy=title&order=desc');
    const titles = res.body.data.map((t) => t.title);
    expect(titles.every((t) => /node/i.test(t))).toBe(true);
    expect(titles).toEqual([...titles].sort().reverse());
  });

  it('search + pagination', async () => {
    const res = await list(searchQuery('node') + '&limit=2&page=1');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.totalCount).toBe(4);
  });

  it('sort + pagination', async () => {
    const res = await list('?sortBy=title&order=asc&limit=3&page=1');
    expect(res.body.data).toHaveLength(3);
    const titles = res.body.data.map((t) => t.title);
    expect(titles).toEqual([...titles].sort());
  });

  it('filter + search + sorting', async () => {
    const res = await list(`?priority=high&sortBy=title&order=asc${searchQuery('node').replace('?', '&')}`);
    expect(res.body.data.every((t) => t.priority === 'high' && /node/i.test(t.title))).toBe(true);
    const titles = res.body.data.map((t) => t.title);
    expect(titles).toEqual([...titles].sort());
  });

  it('filter + search + pagination', async () => {
    // priority=high + search=node matches alpha, beta, gamma (3 total).
    const res = await list(`?priority=high&limit=1&page=2${searchQuery('node').replace('?', '&')}`);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.totalCount).toBe(3);
  });

  it('filter + sorting + pagination', async () => {
    const res = await list('?status=todo&sortBy=title&order=asc&limit=2&page=1');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((t) => t.status === 'todo')).toBe(true);
    expect(res.body.pagination.totalCount).toBe(4);
  });

  it('search + sorting + pagination', async () => {
    const res = await list(searchQuery('node') + '&sortBy=title&order=asc&limit=2&page=2');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.totalCount).toBe(4);
  });

  it('filter + search + sorting + pagination, all at once', async () => {
    const res = await list(
      `?priority=high&status=todo&sortBy=title&order=asc&limit=1&page=1${searchQuery('node').replace('?', '&')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ priority: 'high', status: 'todo' });
    expect(res.body.pagination.totalCount).toBe(2); // alpha, beta
  });

  it('totalCount stays correct for a combined filter and search', async () => {
    const res = await list(`?priority=high${searchQuery('node').replace('?', '&')}&limit=1`);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.totalCount).toBe(3);
  });

  it('sorting remains correct within a paginated, filtered result', async () => {
    const page1 = await list('?priority=high&sortBy=title&order=asc&limit=2&page=1');
    const page2 = await list('?priority=high&sortBy=title&order=asc&limit=2&page=2');
    const combined = [...page1.body.data, ...page2.body.data].map((t) => t.title);
    expect(combined).toEqual([...combined].sort());
  });
});
