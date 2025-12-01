import dotenv from 'dotenv'
dotenv.config({ path: '.env' })
dotenv.config({ path: '.env.local' })
import fs from 'fs'
import path from 'path'

const REQUIRED_ENVS = [
  'OPENAI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY'
]

function checkEnv() {
  const missing = REQUIRED_ENVS.filter(k => !process.env[k])
  return { missing, present: REQUIRED_ENVS.filter(k => !!process.env[k]) }
}

function checkFile(filePath: string) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
}

function main() {
  const biblePath = process.argv[2] || 'data/BibleKJV.txt'
  const envStatus = checkEnv()
  const fileOk = checkFile(biblePath)
  const schemaExists = fs.existsSync(path.join('supabase','schema.sql'))

  const report = {
    biblePath,
    bibleFileFound: fileOk,
    env: envStatus,
    schemaExists,
    suggestions: [] as string[]
  }

  if (!fileOk) report.suggestions.push(`Bible file not found: ${biblePath}. Adjust path or place file.`)
  if (envStatus.missing.length) report.suggestions.push(`Missing env vars: ${envStatus.missing.join(', ')}`)
  if (!schemaExists) report.suggestions.push('Missing supabase/schema.sql—apply migration first.')
  if (!process.env.OPENAI_EMBEDDING_DIMENSIONS) report.suggestions.push('Set OPENAI_EMBEDDING_DIMENSIONS=512 in .env.local for consistency.')

  console.log(JSON.stringify(report, null, 2))
  if (report.suggestions.length) process.exitCode = 1
}

main()
