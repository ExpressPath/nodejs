const config = require('./config');

function extractApiKey(req) {
  const authorization = req.get('authorization') || '';

  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }

  return (req.get('x-helper-key') || '').trim();
}

function requireHelperAuth(req, res, next) {
  if (config.allowAnonymousHelper) {
    return next();
  }

  const apiKey = extractApiKey(req);
  if (apiKey && apiKey === config.helperApiKey) {
    return next();
  }

  return res.status(401).json({
    success: false,
    requestId: req.id,
    error: 'Unauthorized helper request'
  });
}

module.exports = {
  requireHelperAuth
};