// Load .env.local into process.env for tests
const fs = require('fs')
const path = require('path')
const dotenv = require('dotenv')

const envLocalPath = path.resolve(__dirname, '..', '.env.local')
if (fs.existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath })
}
// Also load .env if present as a fallback
const envPath = path.resolve(__dirname, '..', '.env')
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath })
}
