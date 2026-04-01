const express = require('express');
const { randomUUID } = require('node:crypto');
const router = require('./routes/index');
const config = require('./lib/config');
const jobManager = require('./lib/job-manager');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);

app.use((req, res, next) => {
  req.id = randomUUID();
  req.startedAt = Date.now();
  res.setHeader('X-Request-Id', req.id);
  next();
});

if (config.corsAllowOrigin) {
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', config.corsAllowOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Helper-Key, X-Request-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');

    if (config.corsAllowOrigin !== '*') {
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    next();
  });
}

app.use(express.json({ limit: config.jsonLimit }));
app.use(express.urlencoded({ extended: true, limit: config.urlencodedLimit }));

app.use((req, res, next) => {
  res.on('finish', () => {
    const durationMs = Date.now() - req.startedAt;
    console.info(JSON.stringify({
      level: 'info',
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs,
      ip: req.ip,
      userAgent: req.get('user-agent') || null
    }));
  });

  next();
});

app.use('/', router);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    requestId: req.id,
    error: 'Route not found'
  });
});

app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;

  console.error(JSON.stringify({
    level: 'error',
    requestId: req.id,
    message: err.message,
    stack: err.stack,
    statusCode,
    details: err.details || null
  }));

  res.status(statusCode).json({
    success: false,
    requestId: req.id,
    error: err.message || 'Internal Server Error',
    details: err.details || null
  });
});

jobManager.startMaintenance();
jobManager.bootstrap().catch((error) => {
  console.error(JSON.stringify({
    level: 'error',
    message: 'Failed to bootstrap job manager',
    error: error.message,
    stack: error.stack
  }));
});

if (require.main === module) {
  const server = app.listen(config.port, () => {
    console.log(`${config.serviceName} listening on port ${config.port}`);
  });

  server.requestTimeout = config.httpRequestTimeoutMs;
}

module.exports = app;