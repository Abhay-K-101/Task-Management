function notFoundHandler(req, res) {
  res.status(404).json({ success: false, message: 'Route not found' });
}

function errorHandler(err, req, res, next) {
  // --- Body-parser failures -------------------------------------------------
  // These two are distinct client mistakes and deserve distinct answers.
  // Collapsing them into one status would leave a caller guessing whether
  // their JSON was malformed or simply too big.

  // Syntactically invalid JSON. The raw body is never echoed back: it is
  // attacker-controlled text, and reflecting it invites both information
  // leakage and response-splitting style mischief.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Malformed JSON in request body' });
  }

  // Body exceeded the configured limit (Phase 6). The message states the fact
  // without naming the configured limit, which would just tell an attacker
  // exactly how large a payload to send to stay under it.
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Request body is too large' });
  }

  // --- Application errors ---------------------------------------------------

  if (err.name === 'ValidationError') {
    return res.status(400).json({ success: false, message: err.message });
  }

  if (err.statusCode) {
    return res.status(err.statusCode).json({ success: false, message: err.message });
  }

  // --- Anything unexpected --------------------------------------------------
  // The stack goes to the server log, never to the client. A stack trace
  // names filesystem paths, dependency versions and internal call structure —
  // a free map of the application for anyone probing it.
  console.error(err.stack);
  res.status(500).json({ success: false, message: 'Something went wrong' });
}

export { notFoundHandler, errorHandler };
