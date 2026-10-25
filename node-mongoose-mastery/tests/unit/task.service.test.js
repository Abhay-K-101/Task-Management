import { describe, it, expect, vi, beforeEach } from 'vitest';
import taskRepository from '../../src/repositories/task.repository.js';
import taskService from '../../src/services/task.service.js';

// task.service.js is unit-tested here with the repository fully mocked —
// no MongoDB, no Mongoose, no network I/O. This proves the service's own
// decisions (query validation, the completed/status invariant, not-found
// translation) independent of whether the repository/database actually
// works, and it runs in milliseconds. The repository's own behaviour
// (whether Task.find really applies a filter) is instead proven by the
// integration suite, against a real in-memory MongoDB.
vi.mock('../../src/repositories/task.repository.js', () => ({
  default: {
    isValidId: vi.fn(),
    create: vi.fn(),
    findAll: vi.fn(),
    findById: vi.fn(),
    updateById: vi.fn(),
    deleteById: vi.fn(),
  },
}));

// Phase 5: every task service function is scoped to an owner. A fixed id is
// used throughout so assertions can state exactly which owner the repository
// was asked about.
const OWNER_ID = '64b7f1f1f1f1f1f1f1f1f1aa';

beforeEach(() => {
  vi.clearAllMocks();
  taskRepository.isValidId.mockReturnValue(true);
});

describe('ownership guard', () => {
  // Phase 5 safety net. Every task operation must be scoped to an owner; a
  // missing ownerId means a controller or route forgot to supply one, and the
  // service must refuse rather than run an unscoped query that would read or
  // modify every user's data.
  it.each([
    ['createTask', () => taskService.createTask({ title: 'x' }, undefined)],
    ['listTasks', () => taskService.listTasks({}, undefined)],
    ['getTaskById', () => taskService.getTaskById('507f1f77bcf86cd799439011', undefined)],
    ['updateTask', () => taskService.updateTask('507f1f77bcf86cd799439011', {}, undefined)],
    ['deleteTask', () => taskService.deleteTask('507f1f77bcf86cd799439011', undefined)],
  ])('%s throws when no ownerId is supplied, and touches no repository', async (_label, call) => {
    await expect(call()).rejects.toThrow(/ownerId is required/);

    expect(taskRepository.create).not.toHaveBeenCalled();
    expect(taskRepository.findAll).not.toHaveBeenCalled();
    expect(taskRepository.findById).not.toHaveBeenCalled();
    expect(taskRepository.updateById).not.toHaveBeenCalled();
    expect(taskRepository.deleteById).not.toHaveBeenCalled();
  });

  it('raises a plain error with no statusCode, so it surfaces as a 500 not a 4xx', async () => {
    // A missing ownerId is a programming mistake, not something a client did.
    const error = await taskService.listTasks({}, undefined).catch((e) => e);
    expect(error.statusCode).toBeUndefined();
  });
});

describe('createTask', () => {
  it('passes data through unchanged when neither completed nor status is supplied', async () => {
    taskRepository.create.mockResolvedValue({ _id: '1', title: 'x' });

    await taskService.createTask({ title: 'x' }, OWNER_ID);

    expect(taskRepository.create).toHaveBeenCalledWith({ title: 'x', owner: OWNER_ID });
  });

  it('derives completed from a status-only payload before calling the repository', async () => {
    taskRepository.create.mockResolvedValue({});

    await taskService.createTask({ title: 'x', status: 'done' }, OWNER_ID);

    expect(taskRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'done', completed: true })
    );
  });

  it('derives status from a completed-only payload before calling the repository', async () => {
    taskRepository.create.mockResolvedValue({});

    await taskService.createTask({ title: 'x', completed: true }, OWNER_ID);

    expect(taskRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ completed: true, status: 'done' })
    );
  });

  it('leaves a consistent explicit combination untouched', async () => {
    taskRepository.create.mockResolvedValue({});

    await taskService.createTask({ title: 'x', status: 'in-progress', completed: false }, OWNER_ID);

    expect(taskRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'in-progress', completed: false })
    );
  });

  it('rejects a contradictory combination without ever calling the repository', async () => {
    await expect(
      taskService.createTask({ title: 'x', status: 'done', completed: false }, OWNER_ID)
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(taskRepository.create).not.toHaveBeenCalled();
  });

  it('returns whatever the repository resolves', async () => {
    const created = { _id: '1', title: 'x' };
    taskRepository.create.mockResolvedValue(created);

    const result = await taskService.createTask({ title: 'x' }, OWNER_ID);

    expect(result).toBe(created);
  });
});

describe('listTasks', () => {
  function mockFindAll(totalCount, tasks = []) {
    taskRepository.findAll.mockResolvedValue({ tasks, totalCount });
  }

  it('uses documented defaults when no query parameters are supplied', async () => {
    mockFindAll(0);

    await taskService.listTasks({}, OWNER_ID);

    expect(taskRepository.findAll).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      filter: {},
      search: undefined,
      sortBy: 'createdAt',
      order: 'desc',
      page: 1,
      limit: 10,
    });
  });

  it('converts completed=true/false query strings into booleans in the filter', async () => {
    mockFindAll(0);

    await taskService.listTasks({ completed: 'true' }, OWNER_ID);
    expect(taskRepository.findAll).toHaveBeenLastCalledWith(
      expect.objectContaining({ filter: { completed: true } })
    );

    await taskService.listTasks({ completed: 'false' }, OWNER_ID);
    expect(taskRepository.findAll).toHaveBeenLastCalledWith(
      expect.objectContaining({ filter: { completed: false } })
    );
  });

  it('rejects an invalid completed value before calling the repository', async () => {
    await expect(taskService.listTasks({ completed: 'maybe' }, OWNER_ID)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(taskRepository.findAll).not.toHaveBeenCalled();
  });

  it.each(['todo', 'in-progress', 'done'])('accepts status=%s into the filter', async (status) => {
    mockFindAll(0);
    await taskService.listTasks({ status }, OWNER_ID);
    expect(taskRepository.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { status } })
    );
  });

  it('rejects an invalid status before calling the repository', async () => {
    await expect(taskService.listTasks({ status: 'archived' }, OWNER_ID)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(taskRepository.findAll).not.toHaveBeenCalled();
  });

  it('rejects an invalid priority before calling the repository', async () => {
    await expect(taskService.listTasks({ priority: 'urgent' }, OWNER_ID)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(taskRepository.findAll).not.toHaveBeenCalled();
  });

  it('combines multiple filters into one filter object', async () => {
    mockFindAll(0);
    await taskService.listTasks({ completed: 'false', priority: 'high', status: 'todo' }, OWNER_ID);
    expect(taskRepository.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { completed: false, priority: 'high', status: 'todo' } })
    );
  });

  it('trims a non-empty search term and passes it through', async () => {
    mockFindAll(0);
    await taskService.listTasks({ search: '  node  ' }, OWNER_ID);
    expect(taskRepository.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'node' })
    );
  });

  it.each(['', '   '])('treats search=%j as no search at all', async (search) => {
    mockFindAll(0);
    await taskService.listTasks({ search }, OWNER_ID);
    expect(taskRepository.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ search: undefined })
    );
  });

  it.each(['title', 'createdAt', 'updatedAt'])('accepts sortBy=%s', async (sortBy) => {
    mockFindAll(0);
    await taskService.listTasks({ sortBy }, OWNER_ID);
    expect(taskRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ sortBy }));
  });

  it('rejects an invalid sortBy before calling the repository', async () => {
    await expect(taskService.listTasks({ sortBy: 'notAField' }, OWNER_ID)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(taskRepository.findAll).not.toHaveBeenCalled();
  });

  it('rejects an invalid order before calling the repository', async () => {
    await expect(taskService.listTasks({ order: 'sideways' }, OWNER_ID)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(taskRepository.findAll).not.toHaveBeenCalled();
  });

  it.each([
    ['0', false],
    ['1', true],
    ['2', true],
    ['-1', false],
    ['1.5', false],
    ['abc', false],
  ])('page=%s is accepted: %s (boundary/type)', async (page, shouldPass) => {
    mockFindAll(0);
    if (shouldPass) {
      await taskService.listTasks({ page }, OWNER_ID);
      expect(taskRepository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ page: Number(page) })
      );
    } else {
      await expect(taskService.listTasks({ page }, OWNER_ID)).rejects.toMatchObject({ statusCode: 400 });
      expect(taskRepository.findAll).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['0', false],
    ['1', true],
    ['100', true],
    ['101', false],
    ['-5', false],
    ['2.5', false],
    ['abc', false],
  ])('limit=%s is accepted: %s (boundary/type)', async (limit, shouldPass) => {
    mockFindAll(0);
    if (shouldPass) {
      await taskService.listTasks({ limit }, OWNER_ID);
      expect(taskRepository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ limit: Number(limit) })
      );
    } else {
      await expect(taskService.listTasks({ limit }, OWNER_ID)).rejects.toMatchObject({ statusCode: 400 });
      expect(taskRepository.findAll).not.toHaveBeenCalled();
    }
  });

  it.each([
    // [totalCount, limit, page, expectedTotalPages, expectedHasNext, expectedHasPrev]
    [0, 10, 1, 1, false, false],
    [25, 10, 1, 3, true, false],
    [25, 10, 2, 3, true, true],
    [25, 10, 3, 3, false, true],
    [5, 10, 1, 1, false, false],
  ])(
    'computes pagination metadata for totalCount=%i limit=%i page=%i',
    async (totalCount, limit, page, expectedTotalPages, expectedHasNext, expectedHasPrev) => {
      mockFindAll(totalCount);

      const result = await taskService.listTasks({ page: String(page), limit: String(limit) }, OWNER_ID);

      expect(result.pagination).toEqual({
        page,
        limit,
        totalCount,
        totalPages: expectedTotalPages,
        hasNextPage: expectedHasNext,
        hasPrevPage: expectedHasPrev,
      });
    }
  );

  it('returns the tasks array from the repository unchanged', async () => {
    const tasks = [{ _id: '1' }, { _id: '2' }];
    mockFindAll(2, tasks);

    const result = await taskService.listTasks({}, OWNER_ID);

    expect(result.tasks).toBe(tasks);
  });
});

describe('query parameter pollution (Phase 6)', () => {
  // The rule lives in the service, alongside the rest of the query validation,
  // so it is enforced before the repository is ever consulted. These assertions
  // prove the rejection happens at that boundary rather than being cleaned up
  // somewhere downstream.
  const AMBIGUOUS_SHAPES = [
    ['a duplicated value (array)', ['a', 'b']],
    ['a single-element array', ['a']],
    ['an operator-shaped object', { $ne: 'x' }],
    ['a nested object', { deep: { deeper: 'x' } }],
  ];

  const PARAMS = ['completed', 'status', 'priority', 'sortBy', 'order', 'page', 'limit', 'search'];

  it.each(PARAMS)('rejects %s when it arrives as an array', async (param) => {
    await expect(taskService.listTasks({ [param]: ['a', 'b'] }, OWNER_ID)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(taskRepository.findAll).not.toHaveBeenCalled();
  });

  it.each(PARAMS)('rejects %s when it arrives as an object', async (param) => {
    await expect(
      taskService.listTasks({ [param]: { $ne: 'x' } }, OWNER_ID)
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(taskRepository.findAll).not.toHaveBeenCalled();
  });

  it.each(AMBIGUOUS_SHAPES)('never calls the repository for %s', async (_label, value) => {
    await expect(taskService.listTasks({ status: value }, OWNER_ID)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(taskRepository.findAll).not.toHaveBeenCalled();
  });

  it('names the offending parameter without echoing its value', async () => {
    const error = await taskService
      .listTasks({ search: { $ne: 'SECRETVALUE' } }, OWNER_ID)
      .catch((e) => e);

    expect(error.message).toMatch(/search/);
    expect(error.message).not.toContain('SECRETVALUE');
  });

  it('still accepts ordinary scalar values', async () => {
    taskRepository.findAll.mockResolvedValue({ tasks: [], totalCount: 0 });

    await taskService.listTasks(
      { status: 'todo', priority: 'high', completed: 'false', page: '1', limit: '10', search: 'x' },
      OWNER_ID
    );

    expect(taskRepository.findAll).toHaveBeenCalledTimes(1);
  });

  it('ignores unrecognised parameters rather than rejecting them', async () => {
    // Only what the API actually consumes is policed, so a caller appending
    // their own tracking parameter is unaffected.
    taskRepository.findAll.mockResolvedValue({ tasks: [], totalCount: 0 });

    await taskService.listTasks({ utm_source: ['a', 'b'], owner: { $ne: null } }, OWNER_ID);

    expect(taskRepository.findAll).toHaveBeenCalledTimes(1);
  });

  it('rejects before the ownership-scoped query is built', async () => {
    await expect(taskService.listTasks({ page: ['1', '2'] }, OWNER_ID)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(taskRepository.findAll).not.toHaveBeenCalled();
    expect(taskRepository.findById).not.toHaveBeenCalled();
  });
});

describe('getTaskById', () => {
  it('rejects a malformed id without calling the repository', async () => {
    taskRepository.isValidId.mockReturnValue(false);

    await expect(taskService.getTaskById('not-an-id', OWNER_ID)).rejects.toMatchObject({ statusCode: 400 });

    expect(taskRepository.findById).not.toHaveBeenCalled();
  });

  it('converts a repository null result into a 404', async () => {
    taskRepository.findById.mockResolvedValue(null);

    await expect(taskService.getTaskById('507f1f77bcf86cd799439011', OWNER_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('returns the task the repository finds', async () => {
    const task = { _id: '507f1f77bcf86cd799439011', title: 'x' };
    taskRepository.findById.mockResolvedValue(task);

    const result = await taskService.getTaskById(task._id, OWNER_ID);

    expect(result).toBe(task);
  });
});

describe('updateTask', () => {
  it('rejects a malformed id without calling findById or updateById', async () => {
    taskRepository.isValidId.mockReturnValue(false);

    await expect(taskService.updateTask('bad-id', { title: 'x' }, OWNER_ID)).rejects.toMatchObject({
      statusCode: 400,
    });

    expect(taskRepository.findById).not.toHaveBeenCalled();
    expect(taskRepository.updateById).not.toHaveBeenCalled();
  });

  it('returns 404 and never calls updateById when the task does not exist', async () => {
    taskRepository.findById.mockResolvedValue(null);

    await expect(
      taskService.updateTask('507f1f77bcf86cd799439011', { title: 'x' }, OWNER_ID)
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(taskRepository.updateById).not.toHaveBeenCalled();
  });

  it('fetches the existing task before writing, to know its current status', async () => {
    taskRepository.findById.mockResolvedValue({ status: 'in-progress' });
    taskRepository.updateById.mockResolvedValue({});

    await taskService.updateTask('507f1f77bcf86cd799439011', { completed: false }, OWNER_ID);

    expect(taskRepository.findById).toHaveBeenCalledWith('507f1f77bcf86cd799439011', OWNER_ID);
  });

  it('preserves an existing in-progress status when completed is set to false', async () => {
    taskRepository.findById.mockResolvedValue({ status: 'in-progress' });
    taskRepository.updateById.mockResolvedValue({});

    await taskService.updateTask('507f1f77bcf86cd799439011', { completed: false }, OWNER_ID);

    expect(taskRepository.updateById).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      OWNER_ID,
      expect.not.objectContaining({ status: expect.anything() })
    );
  });

  it('pulls status back to todo when completed is set false on a done task', async () => {
    taskRepository.findById.mockResolvedValue({ status: 'done' });
    taskRepository.updateById.mockResolvedValue({});

    await taskService.updateTask('507f1f77bcf86cd799439011', { completed: false }, OWNER_ID);

    expect(taskRepository.updateById).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      OWNER_ID,
      expect.objectContaining({ status: 'todo' })
    );
  });

  it('rejects a contradictory update before calling updateById, even though the task was fetched', async () => {
    taskRepository.findById.mockResolvedValue({ status: 'todo' });

    await expect(
      taskService.updateTask('507f1f77bcf86cd799439011', { status: 'done', completed: false }, OWNER_ID)
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(taskRepository.findById).toHaveBeenCalled();
    expect(taskRepository.updateById).not.toHaveBeenCalled();
  });

  it('converts a null updateById result (task removed mid-request) into a 404', async () => {
    taskRepository.findById.mockResolvedValue({ status: 'todo' });
    taskRepository.updateById.mockResolvedValue(null);

    await expect(
      taskService.updateTask('507f1f77bcf86cd799439011', { title: 'x' }, OWNER_ID)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns the updated task on success', async () => {
    const updated = { _id: '507f1f77bcf86cd799439011', title: 'x' };
    taskRepository.findById.mockResolvedValue({ status: 'todo' });
    taskRepository.updateById.mockResolvedValue(updated);

    const result = await taskService.updateTask('507f1f77bcf86cd799439011', { title: 'x' }, OWNER_ID);

    expect(result).toBe(updated);
  });
});

describe('deleteTask', () => {
  it('rejects a malformed id without calling the repository', async () => {
    taskRepository.isValidId.mockReturnValue(false);

    await expect(taskService.deleteTask('bad-id', OWNER_ID)).rejects.toMatchObject({ statusCode: 400 });

    expect(taskRepository.deleteById).not.toHaveBeenCalled();
  });

  it('converts a repository null result into a 404', async () => {
    taskRepository.deleteById.mockResolvedValue(null);

    await expect(taskService.deleteTask('507f1f77bcf86cd799439011', OWNER_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('returns the deleted task on success', async () => {
    const deleted = { _id: '507f1f77bcf86cd799439011' };
    taskRepository.deleteById.mockResolvedValue(deleted);

    const result = await taskService.deleteTask(deleted._id, OWNER_ID);

    expect(result).toBe(deleted);
  });
});
