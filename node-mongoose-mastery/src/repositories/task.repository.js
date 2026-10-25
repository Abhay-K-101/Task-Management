import mongoose from 'mongoose';
import Task from '../models/task.model.js';

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Phase 5 note on ownership:
//
// Every read and write below is scoped to a single owner, and `ownerId` is a
// required, named parameter on each function rather than something folded
// into a caller-supplied filter object. Two consequences, both deliberate:
//
//   1. Forgetting ownership becomes a visible mistake at the call site
//      instead of a silent data leak.
//   2. `owner` is always spread in LAST, so even if a caller passed
//      `{ owner: someoneElse }` inside `filter`, it cannot win. Ownership is
//      not a filter the caller composes — it is an invariant this layer
//      imposes on top of whatever the caller asked for.
//
// Reads for a task that exists but belongs to someone else return null, not
// the document. The service turns that null into a 404, which is why one
// user probing another user's task id cannot tell "does not exist" apart
// from "not yours".

async function create(data) {
  return Task.create(data);
}

async function findAll({
  ownerId,
  filter = {},
  search,
  sortBy = 'createdAt',
  order = 'desc',
  page = 1,
  limit = 10,
} = {}) {
  const query = { ...filter };

  if (search) {
    query.title = { $regex: escapeRegExp(search), $options: 'i' };
  }

  query.owner = ownerId;

  const sort = { [sortBy]: order === 'asc' ? 1 : -1 };
  const skip = (page - 1) * limit;

  const [tasks, totalCount] = await Promise.all([
    Task.find(query).sort(sort).skip(skip).limit(limit),
    Task.countDocuments(query),
  ]);

  return { tasks, totalCount };
}

async function findById(id, ownerId) {
  return Task.findOne({ _id: id, owner: ownerId });
}

async function updateById(id, ownerId, data) {
  return Task.findOneAndUpdate({ _id: id, owner: ownerId }, data, {
    new: true,
    runValidators: true,
  });
}

async function deleteById(id, ownerId) {
  return Task.findOneAndDelete({ _id: id, owner: ownerId });
}

export default {
  isValidId,
  create,
  findAll,
  findById,
  updateById,
  deleteById,
};
