import { describe, it, expect, vi } from 'vitest';
import {
  validateCreateTask,
  validateUpdateTask,
} from '../../src/middleware/task-validation.middleware.js';

// These are unit tests: no Express app, no HTTP, no MongoDB. Each middleware
// function is called directly with minimal req/res/next test doubles, the
// same way Express itself would call it — (req, res, next) — so we can
// verify its decisions in isolation, in milliseconds, with no database.

function buildRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('validateCreateTask', () => {
  it('calls next() exactly once for a minimal valid body', () => {
    const req = { body: { title: 'Buy milk' } };
    const res = buildRes();
    const next = vi.fn();

    validateCreateTask(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('does not mutate req.body beyond what the contract documents', () => {
    // Trimming happens later, at the Mongoose schema layer (see
    // src/models/task.model.js) — this middleware only reads a local
    // trimmed copy to check length, it never writes back to req.body.
    const req = { body: { title: '  Buy milk  ' } };
    const res = buildRes();
    const next = vi.fn();

    validateCreateTask(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.body.title).toBe('  Buy milk  ');
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', { nested: true }],
  ])('rejects a title that is %s', (_label, title) => {
    const req = { body: { title } };
    const res = buildRes();
    const next = vi.fn();

    validateCreateTask(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    );
  });

  it('rejects an empty string title', () => {
    const req = { body: { title: '' } };
    const res = buildRes();
    const next = vi.fn();

    validateCreateTask(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects a whitespace-only title', () => {
    const req = { body: { title: '    ' } };
    const res = buildRes();
    const next = vi.fn();

    validateCreateTask(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it.each([
    [2, false],
    [3, true],
    [100, true],
    [101, false],
  ])('title of length %i is accepted: %s (boundary)', (length, shouldPass) => {
    const req = { body: { title: 'a'.repeat(length) } };
    const res = buildRes();
    const next = vi.fn();

    validateCreateTask(req, res, next);

    if (shouldPass) {
      expect(next).toHaveBeenCalledTimes(1);
    } else {
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });

  it.each([
    [0, true],
    [1000, true],
    [1001, false],
  ])('description of length %i is accepted: %s (boundary)', (length, shouldPass) => {
    const req = { body: { title: 'Valid title', description: 'd'.repeat(length) } };
    const res = buildRes();
    const next = vi.fn();

    validateCreateTask(req, res, next);

    if (shouldPass) {
      expect(next).toHaveBeenCalledTimes(1);
    } else {
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });

  it('rejects a non-string description', () => {
    const req = { body: { title: 'Valid title', description: 12345 } };
    const res = buildRes();
    const next = vi.fn();

    validateCreateTask(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it.each(['low', 'medium', 'high'])('accepts priority "%s"', (priority) => {
    const req = { body: { title: 'Valid title', priority } };
    const res = buildRes();
    const next = vi.fn();

    validateCreateTask(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid priority', () => {
    const req = { body: { title: 'Valid title', priority: 'urgent' } };
    const res = buildRes();
    const next = vi.fn();

    validateCreateTask(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it.each(['todo', 'in-progress', 'done'])('accepts status "%s"', (status) => {
    const req = { body: { title: 'Valid title', status } };
    const res = buildRes();
    const next = vi.fn();

    validateCreateTask(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid status', () => {
    const req = { body: { title: 'Valid title', status: 'archived' } };
    const res = buildRes();
    const next = vi.fn();

    validateCreateTask(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('does not enforce the completed/status invariant — that is the service layer\'s job', () => {
    // status "todo" with completed true is contradictory, but this
    // middleware only checks types and allowed values; the cross-field
    // business rule is deliberately owned by task.service.js instead.
    const req = { body: { title: 'Valid title', status: 'todo', completed: true } };
    const res = buildRes();
    const next = vi.fn();

    validateCreateTask(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not reject unknown fields on create (only update enforces a field whitelist)', () => {
    const req = { body: { title: 'Valid title', hackField: true } };
    const res = buildRes();
    const next = vi.fn();

    validateCreateTask(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('accumulates multiple errors into a single 400 response', () => {
    const req = { body: { title: 'ab', priority: 'urgent' } };
    const res = buildRes();
    const next = vi.fn();

    validateCreateTask(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledTimes(1);
    const [responseBody] = res.json.mock.calls[0];
    expect(responseBody.message).toMatch(/title/i);
    expect(responseBody.message).toMatch(/priority/i);
  });

  it('handles a missing body without throwing', () => {
    const req = {};
    const res = buildRes();
    const next = vi.fn();

    expect(() => validateCreateTask(req, res, next)).not.toThrow();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('validateUpdateTask', () => {
  it('calls next() exactly once for a valid partial update', () => {
    const req = { body: { completed: true } };
    const res = buildRes();
    const next = vi.fn();

    validateUpdateTask(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('does not require title on a partial update', () => {
    const req = { body: { description: 'Updated description' } };
    const res = buildRes();
    const next = vi.fn();

    validateUpdateTask(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('accepts an empty update body', () => {
    const req = { body: {} };
    const res = buildRes();
    const next = vi.fn();

    validateUpdateTask(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('handles a missing body without throwing', () => {
    const req = {};
    const res = buildRes();
    const next = vi.fn();

    expect(() => validateUpdateTask(req, res, next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects a single unknown field and names it in the message', () => {
    const req = { body: { hackField: true } };
    const res = buildRes();
    const next = vi.fn();

    validateUpdateTask(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    const [responseBody] = res.json.mock.calls[0];
    expect(responseBody.success).toBe(false);
    expect(responseBody.message).toContain('hackField');
  });

  it('rejects multiple unknown fields and names all of them', () => {
    const req = { body: { hackField: true, other: 1 } };
    const res = buildRes();
    const next = vi.fn();

    validateUpdateTask(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const [responseBody] = res.json.mock.calls[0];
    expect(responseBody.message).toContain('hackField');
    expect(responseBody.message).toContain('other');
  });

  it.each(['_id', 'createdAt', 'updatedAt'])(
    'rejects an attempt to set the internal field "%s"',
    (field) => {
      const req = { body: { [field]: 'anything' } };
      const res = buildRes();
      const next = vi.fn();

      validateUpdateTask(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    }
  );

  it.each([
    [2, false],
    [3, true],
    [100, true],
    [101, false],
  ])('an update title of length %i is accepted: %s (boundary)', (length, shouldPass) => {
    const req = { body: { title: 'a'.repeat(length) } };
    const res = buildRes();
    const next = vi.fn();

    validateUpdateTask(req, res, next);

    if (shouldPass) {
      expect(next).toHaveBeenCalledTimes(1);
    } else {
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('rejects a description over 1000 characters on update', () => {
    const req = { body: { description: 'd'.repeat(1001) } };
    const res = buildRes();
    const next = vi.fn();

    validateUpdateTask(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects an invalid priority on update', () => {
    const req = { body: { priority: 'urgent' } };
    const res = buildRes();
    const next = vi.fn();

    validateUpdateTask(req, res, next);

    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an invalid status on update', () => {
    const req = { body: { status: 'archived' } };
    const res = buildRes();
    const next = vi.fn();

    validateUpdateTask(req, res, next);

    expect(next).not.toHaveBeenCalled();
  });

  it.each(['yes', 1, 'true', null])(
    'rejects a non-boolean completed value: %s',
    (completed) => {
      const req = { body: { completed } };
      const res = buildRes();
      const next = vi.fn();

      validateUpdateTask(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    }
  );

  it.each([true, false])('accepts a boolean completed value: %s', (completed) => {
    const req = { body: { completed } };
    const res = buildRes();
    const next = vi.fn();

    validateUpdateTask(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not enforce the completed/status invariant on update either', () => {
    const req = { body: { status: 'done', completed: false } };
    const res = buildRes();
    const next = vi.fn();

    validateUpdateTask(req, res, next);

    // Type/allowed-value checks both pass individually; the contradiction
    // between them is caught later, by task.service.js.
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not mutate req.body', () => {
    const req = { body: { title: '  Buy milk  ', completed: true } };
    const res = buildRes();
    const next = vi.fn();

    validateUpdateTask(req, res, next);

    expect(req.body).toEqual({ title: '  Buy milk  ', completed: true });
  });
});
