const express = require('express');
const path = require('path');
const indexRouter = require('./routes/index');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware: parse JSON bodies
app.use(express.json());

// Middleware: log request method and url
app.use((req, res, next) => {
  console.info(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Static files
app.use(express.static(path.resolve(__dirname, 'public')));

// Main routes
app.use('/', indexRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).sendFile(path.resolve(__dirname, 'views', '404.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Internal Server Error');
});

app.listen(PORT, () => {
  console.log(`Server listening: http://localhost:${PORT}`);
});