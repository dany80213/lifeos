#!/usr/bin/env node
// Prints the .env.local lines for LifeOS login.
//
//   node scripts/lifeos-password.mjs <username> <password>
//
// Paste the printed lines into .env.local on the machine running the bridge.
// The password itself is never stored — only its scrypt hash.

import { randomBytes } from 'node:crypto'
import { hashPassword } from '../bridge/auth.mjs'

const [username, password] = process.argv.slice(2)

if (!username || !password) {
  console.error('usage: node scripts/lifeos-password.mjs <username> <password>')
  process.exit(1)
}

console.log('')
console.log('Add these to .env.local:')
console.log('')
console.log(`LIFEOS_USERNAME=${username}`)
console.log(`LIFEOS_PASSWORD_HASH=${hashPassword(password)}`)
console.log(`LIFEOS_SESSION_SECRET=${randomBytes(32).toString('hex')}`)
console.log('')
