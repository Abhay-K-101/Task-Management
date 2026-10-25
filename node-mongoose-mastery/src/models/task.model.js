import mongoose from 'mongoose';

const taskSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      minlength: [3, 'Title must be at least 3 characters long'],
      maxlength: [100, 'Title must be at most 100 characters long'],
    },
    description: {
      type: String,
      trim: true,
      default: '',
      maxlength: [1000, 'Description must be at most 1000 characters long'],
    },
    completed: {
      type: Boolean,
      default: false,
    },
    priority: {
      type: String,
      enum: {
        values: ['low', 'medium', 'high'],
        message: 'Priority must be one of: low, medium, high',
      },
      default: 'medium',
    },
    status: {
      type: String,
      enum: {
        values: ['todo', 'in-progress', 'done'],
        message: 'Status must be one of: todo, in-progress, done',
      },
      default: 'todo',
    },
    // Added in Phase 5. Every task belongs to exactly one user, and there is
    // no such thing as an unowned task — `required` makes that a schema-level
    // guarantee rather than a convention the service layer has to remember.
    //
    // The client never supplies this value: task.service.js sets it from the
    // authenticated request, and task-validation.middleware.js rejects any
    // request that tries to send it. The index exists because *every* task
    // query is now scoped by owner, so it is the most-used filter in the app.
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Owner is required'],
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

const Task = mongoose.model('Task', taskSchema);

export default Task;
