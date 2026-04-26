{
  "name": "plaid-finance-app",
  "version": "1.0.0",
  "description": "Personal finance dashboard with Plaid integration",
  "main": "server/index.js",
  "scripts": {
    "start": "node server/index.js",
    "dev": "nodemon server/index.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "plaid": "^25.0.0",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "node-fetch": "^2.7.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.2"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
