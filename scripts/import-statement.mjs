#!/usr/bin/env node
// Imports bank statements into LifeOS Finanze — see bridge/lifeos-import.mjs.
//   node scripts/import-statement.mjs [--dry-run] file [file…]
// Run it where the store lives (data/lifeos-store.json, or LIFEOS_STORE_PATH).
import { readFile } from 'node:fs/promises'
import { importStatement } from '../bridge/lifeos-store.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const files = args.filter((a) => !a.startsWith('--'))
if (!files.length) { console.error('Uso: import-statement.mjs [--dry-run] file…'); process.exit(1) }
const eur = (n) => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' })
for (const f of files) {
  try {
    const r = await importStatement(await readFile(f), { dryRun })
    console.log(`\n${f.split('/').pop()} → ${r.account}${r.accountCreated ? ' (conto creato)' : ''}${dryRun ? '  [prova, nulla scritto]' : ''}`)
    console.log(`  ${r.added} nuovi, ${r.duplicates} già presenti, ${r.toAsk} da chiederti, ${r.ownTransfers} giroconti ignorati · saldo ${r.balance == null ? '—' : eur(r.balance)}${r.balanceUpdated ? ' (aggiornato)' : ''}`)
    for (const m of r.movements) console.log(`  ${m.date} ${m.type === 'spesa' ? '-' : '+'}${String(m.amount.toFixed(2)).padStart(8)}  ${m.category.padEnd(22)} ${m.description}`)
    for (const q of r.questions) console.log(`  ${q.date} ${q.type === 'spesa' ? '-' : '+'}${String(q.amount.toFixed(2)).padStart(8)}  ?  ${q.description}`)
  } catch (e) { console.error(`\n${f}: ${e.message}`); process.exitCode = 1 }
}
