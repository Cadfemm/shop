import cors from 'cors'
import express from 'express'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import pg from 'pg'
import { fileURLToPath } from 'url'

const { Pool } = pg

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataFile = path.join(__dirname, 'data', 'items.json')
const frontendDir = path.join(__dirname, '..', 'frontend')
const port = Number(process.env.PORT) || 4000
const databaseUrl = process.env.DATABASE_URL

let writeQueue = Promise.resolve()
let pool = null

function withWriteLock(task) {
  const run = writeQueue.then(task, task)
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function roundMoney(value) {
  return Math.round(value * 100) / 100
}

function cleanText(value, max) {
  return String(value ?? '')
    .trim()
    .slice(0, max)
}

function readEntry(body) {
  const nameTe = cleanText(body?.nameTe, 80)
  const name = cleanText(body?.name, 80) || nameTe
  const quantity = cleanText(body?.quantity ?? body?.unit, 40)
  const basePrice = Number(body?.basePrice)
  const sellingPrice = Number(body?.sellingPrice)
  if (
    !name ||
    !quantity ||
    !Number.isFinite(basePrice) ||
    !Number.isFinite(sellingPrice) ||
    basePrice < 0 ||
    sellingPrice < 0
  ) {
    return null
  }
  return {
    name,
    nameTe,
    quantity,
    basePrice: roundMoney(basePrice),
    sellingPrice: roundMoney(sellingPrice),
  }
}

function withQuantity(item) {
  const quantity = cleanText(item.quantity ?? item.unit, 40)
  const nameTe = cleanText(item.nameTe, 80)
  return { ...item, nameTe, quantity, unit: quantity }
}

function searchText(value) {
  return String(value ?? '').normalize('NFC').toLowerCase()
}

function itemId(items, name) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'item'
  let id = base
  let count = 2
  while (items.some((item) => item.id === id)) {
    id = `${base}-${count}`
    count += 1
  }
  return id
}

function mapRow(row) {
  return withQuantity({
    id: row.id,
    name: row.name,
    nameTe: row.name_te,
    category: row.category,
    unit: row.unit,
    quantity: row.quantity,
    basePrice: Number(row.base_price),
    sellingPrice: Number(row.selling_price),
  })
}

async function readJsonItems() {
  const raw = await fs.readFile(dataFile, 'utf8')
  const items = JSON.parse(raw)
  if (!Array.isArray(items)) {
    throw new Error('Item list is not an array')
  }
  return items
}

async function initStore() {
  if (!databaseUrl) return
  pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
  })
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_te TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'General',
      unit TEXT NOT NULL,
      quantity TEXT NOT NULL,
      base_price DOUBLE PRECISION NOT NULL,
      selling_price DOUBLE PRECISION NOT NULL,
      position INTEGER NOT NULL
    )
  `)
  const count = await pool.query('SELECT COUNT(*)::int AS count FROM items')
  if (count.rows[0].count > 0) return
  const seed = await readJsonItems()
  for (const [position, item] of seed.entries()) {
    const row = withQuantity(item)
    await pool.query(
      `INSERT INTO items
        (id, name, name_te, category, unit, quantity, base_price, selling_price, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        row.id,
        row.name,
        row.nameTe || '',
        row.category || 'General',
        row.quantity,
        row.quantity,
        row.basePrice,
        row.sellingPrice,
        position,
      ],
    )
  }
}

async function readItems() {
  if (!pool) return readJsonItems()
  const result = await pool.query('SELECT * FROM items ORDER BY position, name')
  return result.rows.map(mapRow)
}

async function writeItems(items) {
  if (!pool) {
    const temporary = `${dataFile}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(items, null, 2)}\n`)
    await fs.rename(temporary, dataFile)
    return
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM items')
    for (const [position, item] of items.entries()) {
      const row = withQuantity(item)
      await client.query(
        `INSERT INTO items
          (id, name, name_te, category, unit, quantity, base_price, selling_price, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          row.id,
          row.name,
          row.nameTe || '',
          row.category || 'General',
          row.quantity,
          row.quantity,
          row.basePrice,
          row.sellingPrice,
          position,
        ],
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

function lanAddresses() {
  const addresses = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      const isIpv4 = entry.family === 'IPv4' || entry.family === 4
      if (isIpv4 && !entry.internal) addresses.push(entry.address)
    }
  }
  return addresses
}

const app = express()
app.use(cors())
app.use(express.json())

app.get('/api/items', async (req, res) => {
  try {
    const query = String(req.query.q ?? '')
      .trim()
      .toLowerCase()
    let items = await readItems()
    if (query) {
      const needle = searchText(query)
      items = items.filter((item) => {
        const haystack = searchText(
          `${item.name} ${item.nameTe ?? ''} ${item.quantity ?? ''} ${item.unit ?? ''}`,
        )
        return haystack.includes(needle)
      })
    }
    res.json(items.map(withQuantity))
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Could not read the item list.' })
  }
})

app.post('/api/items', (req, res) => {
  withWriteLock(async () => {
    const entry = readEntry(req.body)
    if (!entry) {
      res.status(400).json({ error: 'Enter the item name, quantity, base price, and selling price.' })
      return
    }

    const items = await readItems()
    const item = withQuantity({
      id: itemId(items, entry.name),
      name: entry.name,
      nameTe: entry.nameTe,
      category: 'General',
      unit: entry.quantity,
      quantity: entry.quantity,
      basePrice: entry.basePrice,
      sellingPrice: entry.sellingPrice,
    })
    items.push(item)
    await writeItems(items)
    res.status(201).json(item)
  }).catch((error) => {
    console.error(error)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Could not add that item.' })
    }
  })
})

app.put('/api/items/:id', (req, res) => {
  withWriteLock(async () => {
    const entry = readEntry(req.body)
    if (!entry) {
      res.status(400).json({ error: 'Enter the item name, quantity, base price, and selling price.' })
      return
    }

    const items = await readItems()
    const index = items.findIndex((item) => item.id === req.params.id)
    if (index === -1) {
      res.status(404).json({ error: 'That item is not on the list.' })
      return
    }

    items[index] = withQuantity({
      ...items[index],
      name: entry.name,
      nameTe: entry.nameTe,
      unit: entry.quantity,
      quantity: entry.quantity,
      basePrice: entry.basePrice,
      sellingPrice: entry.sellingPrice,
    })
    await writeItems(items)
    res.json(items[index])
  }).catch((error) => {
    console.error(error)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Could not save this row.' })
    }
  })
})

app.use(
  express.static(frontendDir, {
    index: 'index.html',
    setHeaders(response) {
      response.setHeader('Cache-Control', 'no-cache')
    },
  }),
)

initStore()
  .then(() => {
    app.listen(port, '0.0.0.0', () => {
      console.log(`Shop rates ready at http://localhost:${port}`)
      for (const address of lanAddresses()) {
        console.log(`On this Wi-Fi, open http://${address}:${port} on the phone`)
      }
    })
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
