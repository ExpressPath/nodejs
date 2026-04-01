const express = require('express');
const path = require('path');
const router = express.Router();

// Home route: serve index.html
router.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../views/index.html'));
});

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Calculation API endpoint
router.post('/calculate', (req, res) => {
  try {
    const { operation, values } = req.body;

    // Validate input
    if (!operation || !Array.isArray(values) || values.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request. Required: operation (string), values (array)'
      });
    }

    let result;

    switch (operation.toLowerCase()) {
      case 'add':
        result = values.reduce((sum, val) => sum + Number(val), 0);
        break;
      case 'subtract':
        result = values.reduce((diff, val) => diff - Number(val));
        break;
      case 'multiply':
        result = values.reduce((prod, val) => prod * Number(val), 1);
        break;
      case 'divide':
        if (values.some(v => Number(v) === 0)) {
          return res.status(400).json({
            success: false,
            error: 'Division by zero'
          });
        }
        result = values.reduce((quot, val) => quot / Number(val));
        break;
      default:
        return res.status(400).json({
          success: false,
          error: `Unknown operation: ${operation}`
        });
    }

    res.json({
      success: true,
      operation,
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Calculation error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

module.exports = router;