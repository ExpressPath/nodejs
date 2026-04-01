const SUPPORTED_OPERATIONS = Object.freeze(['add', 'subtract', 'multiply', 'divide']);

function normalizeValues(values) {
  if (!Array.isArray(values) || values.length === 0) {
    const error = new Error('values must be a non-empty array');
    error.statusCode = 400;
    throw error;
  }

  const normalized = values.map((value) => Number(value));
  if (normalized.some((value) => !Number.isFinite(value))) {
    const error = new Error('values must contain only finite numbers');
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function calculate(operation, values) {
  const normalizedOperation = String(operation || '').trim().toLowerCase();
  if (!SUPPORTED_OPERATIONS.includes(normalizedOperation)) {
    const error = new Error(`Unknown operation: ${operation}`);
    error.statusCode = 400;
    throw error;
  }

  const normalizedValues = normalizeValues(values);

  switch (normalizedOperation) {
    case 'add':
      return normalizedValues.reduce((sum, value) => sum + value, 0);
    case 'subtract':
      return normalizedValues.slice(1).reduce((total, value) => total - value, normalizedValues[0]);
    case 'multiply':
      return normalizedValues.reduce((total, value) => total * value, 1);
    case 'divide':
      if (normalizedValues.slice(1).some((value) => value === 0)) {
        const error = new Error('Division by zero');
        error.statusCode = 400;
        throw error;
      }
      return normalizedValues.slice(1).reduce((total, value) => total / value, normalizedValues[0]);
    default:
      return 0;
  }
}

module.exports = {
  SUPPORTED_OPERATIONS,
  calculate
};