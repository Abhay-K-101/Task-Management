import authService from '../services/auth.service.js';

async function register(req, res, next) {
  try {
    const user = await authService.register(req.body);
    res.status(201).json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
}

async function login(req, res, next) {
  try {
    const { token, user } = await authService.login(req.body);
    res.status(200).json({ success: true, data: { token, user } });
  } catch (error) {
    next(error);
  }
}

async function me(req, res, next) {
  try {
    // req.user was put there by requireAuth, which already verified the token
    // and loaded the account. Re-reading through the service keeps the
    // response shape identical to register/login rather than inventing a
    // third shape for the same entity.
    const user = await authService.getCurrentUser(req.user.id);
    res.status(200).json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
}

export default { register, login, me };
