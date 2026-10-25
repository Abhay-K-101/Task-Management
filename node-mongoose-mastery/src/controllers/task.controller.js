import taskService from '../services/task.service.js';

// req.user is guaranteed to exist on every handler here: each task route
// mounts requireAuth ahead of the controller (see src/routes/task.routes.js),
// so an unauthenticated request is answered with 401 and never reaches this
// file. The owner id is taken from that verified identity and from nowhere
// else — never from the request body or a query parameter.

async function createTask(req, res, next) {
  try {
    const task = await taskService.createTask(req.body, req.user.id);
    res.status(201).json({ success: true, data: task });
  } catch (error) {
    next(error);
  }
}

async function listTasks(req, res, next) {
  try {
    const { tasks, pagination } = await taskService.listTasks(req.query, req.user.id);
    res.status(200).json({ success: true, data: tasks, pagination });
  } catch (error) {
    next(error);
  }
}

async function getTask(req, res, next) {
  try {
    const task = await taskService.getTaskById(req.params.id, req.user.id);
    res.status(200).json({ success: true, data: task });
  } catch (error) {
    next(error);
  }
}

async function updateTask(req, res, next) {
  try {
    const task = await taskService.updateTask(req.params.id, req.body, req.user.id);
    res.status(200).json({ success: true, data: task });
  } catch (error) {
    next(error);
  }
}

async function deleteTask(req, res, next) {
  try {
    await taskService.deleteTask(req.params.id, req.user.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

export default {
  createTask,
  listTasks,
  getTask,
  updateTask,
  deleteTask,
};
