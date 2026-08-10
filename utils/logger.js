/**
 * Colored Logger Utility
 * 
 * Color-coded console logging for easier debugging:
 * - RED: Errors
 * - YELLOW: Warnings
 * - GREEN: Success operations (data uploaded, processed, committed)
 * - BLUE: Client operations (data fetched, received)
 * - CYAN: Info/diagnostic messages
 */

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function timestamp() {
  return new Date().toISOString();
}

function error(message, ...args) {
  console.error(`${colors.red}[ERROR][${timestamp()}] ${message}${colors.reset}`, ...args);
}

function warn(message, ...args) {
  console.warn(`${colors.yellow}[WARN][${timestamp()}] ${message}${colors.reset}`, ...args);
}

function success(message, ...args) {
  console.log(`${colors.green}[SUCCESS][${timestamp()}] ${message}${colors.reset}`, ...args);
}

function client(message, ...args) {
  console.log(`${colors.blue}[CLIENT][${timestamp()}] ${message}${colors.reset}`, ...args);
}

function info(message, ...args) {
  console.log(`${colors.cyan}[INFO][${timestamp()}] ${message}${colors.reset}`, ...args);
}

function debug(message, ...args) {
  console.log(`${colors.gray}[DEBUG][${timestamp()}] ${message}${colors.reset}`, ...args);
}

module.exports = {
  error,
  warn,
  success,
  client,
  info,
  debug,
};
