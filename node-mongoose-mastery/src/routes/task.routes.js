import { Router } from 'express';
import taskController from '../controllers/task.controller.js';
import { validateCreateTask, validateUpdateTask } from '../middleware/task-validation.middleware.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

// Phase 5: every task route is protected, and the chain is always
// requireAuth -> validation -> controller. Authentication runs first on
// purpose: an anonymous caller sending a malformed body gets 401, not a 400
// that would confirm the endpoint's field rules to someone with no account.
//
// requireAuth is attached per route rather than with router.use() so that an
// unregistered method on a known path (PUT /api/tasks, say) still falls
// through to the 404 handler exactly as it did in Phase 3/4, instead of
// becoming a 401 for a route that does not exist.
router.post('/', requireAuth, validateCreateTask, taskController.createTask);
router.get('/', requireAuth, taskController.listTasks);
router.get('/:id', requireAuth, taskController.getTask);
router.patch('/:id', requireAuth, validateUpdateTask, taskController.updateTask);
router.delete('/:id', requireAuth, taskController.deleteTask);

export default router;
