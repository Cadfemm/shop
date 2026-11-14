const listEl = document.querySelector('#list')
const searchEl = document.querySelector('#search')
const clearEl = document.querySelector('#clear')
const statusEl = document.querySelector('#status')
const errorEl = document.querySelector('#error')
const addForm = document.querySelector('#add-form')

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
})

let items = []
let query = ''
let editingId = null
let savedId = null
let savedTimer = 0

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function quantityOf(item) {
  return item.quantity || item.unit || ''
}

function searchText(value) {
  return String(value ?? '').normalize('NFC').toLowerCase()
}

function visibleItems() {
  const needle = searchText(query.trim())
  if (!needle) return items
  return items.filter((item) => {
    const haystack = searchText(`${item.name} ${item.nameTe || ''} ${quantityOf(item)}`)
    return haystack.includes(needle)
  })
}

function showError(message) {
  if (!message) {
    errorEl.hidden = true
    errorEl.textContent = ''
    return
  }
  errorEl.hidden = false
  errorEl.textContent = message
}

function render() {
  const shown = visibleItems()
  const noun = shown.length === 1 ? 'item' : 'items'
  statusEl.textContent = query.trim()
    ? `${shown.length} ${noun} match “${query.trim()}”`
    : `${shown.length} ${noun} on the list`
  clearEl.hidden = query.length === 0

  if (shown.length === 0) {
    listEl.innerHTML = `<tr><td class="empty" colspan="5">Nothing matches that search.</td></tr>`
    return
  }

  listEl.innerHTML = shown.map(renderRow).join('')
}

function renderRow(item) {
  const id = escapeHtml(item.id)
  if (editingId === item.id) {
    return `
      <tr data-item="${id}">
        <td>
          <input name="name" lang="te" autocomplete="off" value="${escapeHtml(item.name)}" aria-label="Item name" />
          <input name="nameTe" lang="te" autocomplete="off" value="${escapeHtml(item.nameTe || '')}" placeholder="తెలుగు పేరు" aria-label="Telugu item name" />
        </td>
        <td><input name="quantity" autocomplete="off" value="${escapeHtml(quantityOf(item))}" aria-label="Quantity" /></td>
        <td class="num"><input name="basePrice" inputmode="decimal" autocomplete="off" value="${item.basePrice}" aria-label="Base price" /></td>
        <td class="num"><input name="sellingPrice" inputmode="decimal" autocomplete="off" value="${item.sellingPrice}" aria-label="Selling price" /></td>
        <td>
          <button class="save" type="button" data-action="save" data-id="${id}">Save</button>
          <button type="button" data-action="cancel" data-id="${id}">Cancel</button>
        </td>
      </tr>
    `
  }

  const editLabel = savedId === item.id ? 'Saved' : 'Edit'
  const editClass = savedId === item.id ? 'saved' : ''
  return `
    <tr data-item="${id}">
      <td><span class="name">${escapeHtml(item.name)}</span>${
        item.nameTe && item.nameTe !== item.name
          ? `<span class="name-te">${escapeHtml(item.nameTe)}</span>`
          : ''
      }</td>
      <td>${escapeHtml(quantityOf(item))}</td>
      <td class="num">${money.format(item.basePrice)}</td>
      <td class="num">${money.format(item.sellingPrice)}</td>
      <td><button class="${editClass}" type="button" data-action="edit" data-id="${id}">${editLabel}</button></td>
    </tr>
  `
}

function readRow(row) {
  const name = row.querySelector('[name="name"]').value.trim()
  const nameTe = row.querySelector('[name="nameTe"]')?.value.trim() || ''
  const quantity = row.querySelector('[name="quantity"]').value.trim()
  const baseRaw = row.querySelector('[name="basePrice"]').value.trim()
  const sellRaw = row.querySelector('[name="sellingPrice"]').value.trim()
  return {
    name,
    nameTe,
    quantity,
    basePrice: baseRaw === '' ? Number.NaN : Number(baseRaw),
    sellingPrice: sellRaw === '' ? Number.NaN : Number(sellRaw),
  }
}

function pricesLookValid(values) {
  return (
    (values.name || values.nameTe) &&
    values.quantity &&
    Number.isFinite(values.basePrice) &&
    Number.isFinite(values.sellingPrice) &&
    values.basePrice >= 0 &&
    values.sellingPrice >= 0
  )
}

async function loadItems() {
  showError('')
  const response = await fetch('/api/items')
  if (!response.ok) throw new Error('Could not load the item list.')
  items = await response.json()
  render()
}

async function saveItem(id, row) {
  const values = readRow(row)
  if (!pricesLookValid(values)) {
    showError('Enter the item name, quantity, and both prices (0 or more).')
    return
  }

  const saveButton = row.querySelector('[data-action="save"]')
  const cancelButton = row.querySelector('[data-action="cancel"]')
  saveButton.disabled = true
  saveButton.textContent = 'Saving…'
  cancelButton.disabled = true
  showError('')
  try {
    const response = await fetch(`/api/items/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Could not save this row.')
    items = items.map((item) => (item.id === id ? body : item))
    editingId = null
    savedId = id
    clearTimeout(savedTimer)
    savedTimer = setTimeout(() => {
      savedId = null
      render()
    }, 1400)
    render()
  } catch (error) {
    saveButton.disabled = false
    saveButton.textContent = 'Save'
    cancelButton.disabled = false
    showError(error.message)
  }
}

addForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const entry = readRow(document.querySelector('.add-row'))
  if (!pricesLookValid(entry)) {
    showError('To add an item, fill the name, quantity, base price, and selling price.')
    return
  }

  const button = document.querySelector('.add-row button')
  button.disabled = true
  showError('')
  try {
    const response = await fetch('/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Could not add that item.')
    items = [...items, body]
    for (const input of document.querySelectorAll('.add-row input')) input.value = ''
    query = ''
    searchEl.value = ''
    editingId = null
    savedId = body.id
    clearTimeout(savedTimer)
    savedTimer = setTimeout(() => {
      savedId = null
      render()
    }, 1400)
    render()
    document.querySelector(`[data-item="${CSS.escape(body.id)}"]`)?.scrollIntoView({ block: 'nearest' })
  } catch (error) {
    showError(error.message)
  } finally {
    button.disabled = false
  }
})

searchEl.addEventListener('input', () => {
  query = searchEl.value
  editingId = null
  render()
})

clearEl.addEventListener('click', () => {
  query = ''
  searchEl.value = ''
  editingId = null
  searchEl.focus()
  render()
})

listEl.addEventListener('click', (event) => {
  const button = event.target.closest('button')
  if (!button) return
  const id = button.dataset.id
  if (button.dataset.action === 'edit') {
    editingId = id
    savedId = null
    showError('')
    render()
    const input = listEl.querySelector(`[data-item="${CSS.escape(id)}"] [name="basePrice"]`)
    input?.focus()
    input?.select()
  }
  if (button.dataset.action === 'cancel') {
    editingId = null
    showError('')
    render()
  }
  if (button.dataset.action === 'save') {
    saveItem(id, button.closest('[data-item]'))
  }
})

listEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return
  const row = event.target.closest('[data-item]')
  if (!row || editingId !== row.dataset.item) return
  event.preventDefault()
  saveItem(row.dataset.item, row)
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !editingId) {
    loadItems().catch((error) => showError(error.message))
  }
})

loadItems().catch((error) => {
  statusEl.textContent = 'Item list unavailable'
  showError(error.message)
})
