import fs from 'node:fs'
import { resolve } from 'node:path'
import chokidar from 'chokidar'
import { NotionAPI } from 'notion-client'
import { parsePageId } from 'notion-utils'

const { NOTION_ACCESS_TOKEN } = process.env

// notion-client@6.16 cannot parse Notion's current API responses (recordMap
// version 3 nesting and the newer queryCollection shape), so this minimal
// client implements the only method Osmium uses (getPage) against the same
// endpoints with shapes that work today. A browser User-Agent is required:
// Notion rejects got's default UA with HTTP 403.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const API_BASE = 'https://www.notion.so/api/v3'
const USER_TIMEZONE = 'America/Los_Angeles'

async function callApi (endpoint: string, body: JsonValue): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  }
  if (NOTION_ACCESS_TOKEN) headers.cookie = `token_v2=${NOTION_ACCESS_TOKEN}`
  const res = await fetch(`${API_BASE}/${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Notion ${endpoint} failed: HTTP ${res.status}`)
  return res.json()
}

// recordMap v3 wraps records in one or more { spaceId/value/role } layers;
// unwrap down to the actual record (which always has an id).
function unwrapEntry (entry: any): { role: string, value: any } {
  let role = typeof entry?.role === 'string' ? entry.role : 'reader'
  let e = entry
  while (e && typeof e === 'object' && !('id' in e) && e.value && typeof e.value === 'object') {
    if (typeof e.role === 'string') role = e.role
    e = e.value
  }
  return { role, value: e }
}

function unwrapTable (table: any): Record<string, { role: string, value: any }> {
  const out: Record<string, { role: string, value: any }> = {}
  for (const [id, entry] of Object.entries(table ?? {})) {
    out[id] = unwrapEntry(entry)
  }
  return out
}

function mergeTables (target: any, source: any) {
  for (const key of ['block', 'collection', 'collection_view', 'notion_user'] as const) {
    Object.assign(target[key], unwrapTable(source?.[key]))
  }
}

async function getPage (pageId: string): Promise<any> {
  const id = parsePageId(pageId)
  if (!id) throw new Error(`invalid notion pageId "${pageId}"`)

  const chunk = await callApi('loadPageChunk', {
    pageId: id,
    limit: 500,
    cursor: { stack: [] },
    chunkNumber: 0,
    verticalColumns: false,
  })

  const recordMap: any = {
    block: {},
    collection: {},
    collection_view: {},
    notion_user: {},
    collection_query: {},
    signed_urls: {},
  }
  mergeTables(recordMap, chunk.recordMap)

  // Fetch collection data for every collection view, and shape it the way
  // notion-client@6.16 returned it (collection_group_results.blockIds).
  for (const entry of Object.values<{ role: string, value: any }>(recordMap.block)) {
    const block = entry.value
    if (!block || (block.type !== 'collection_view_page' && block.type !== 'collection_view')) continue
    const collectionId: string = block.collection_id ?? block.format?.collection_pointer?.id
    const spaceId: string = block.space_id ?? chunk.recordMap?.block?.[id]?.spaceId
    for (const viewId of block.view_ids ?? []) {
      const query = await callApi('queryCollection', {
        source: { type: 'collection', id: collectionId, spaceId },
        collectionView: { id: viewId, spaceId },
        loader: {
          type: 'reducer',
          reducers: { results: { type: 'results', limit: 500 } },
          searchQuery: '',
          userTimeZone: USER_TIMEZONE,
        },
      })
      mergeTables(recordMap, query.recordMap)
      const results = query.result?.reducerResults?.results ?? query.result
      recordMap.collection_query[collectionId] ??= {}
      recordMap.collection_query[collectionId][viewId] = {
        collection_group_results: {
          type: 'results',
          blockIds: results?.blockIds ?? [],
          hasMore: results?.hasMore ?? false,
        },
      }
    }
  }

  // Fetch any referenced content blocks the first responses did not include
  // (the old notion-client did the same via fetchMissingBlocks).
  for (;;) {
    const missing: string[] = []
    for (const entry of Object.values<{ role: string, value: any }>(recordMap.block)) {
      for (const contentId of entry.value?.content ?? []) {
        if (!(contentId in recordMap.block)) missing.push(contentId)
      }
    }
    if (!missing.length) break
    const more = await callApi('syncRecordValues', {
      requests: [...new Set(missing)].map(blockId => ({ table: 'block', id: blockId, version: -1 })),
    })
    mergeTables(recordMap, more.recordMap)
  }

  return recordMap
}

const client = { getPage } as unknown as NotionAPI

const PROXIED_METHODS = [
  'getPage',
]
const $client = new Proxy(client, {
  get (target: NotionAPI, prop: keyof NotionAPI) {
    // Just to reduce the length of IDE inlay hints
    type KeyofNotionAPI = NotionAPI[keyof NotionAPI]
    const raw: KeyofNotionAPI = target[prop]

    if (process.env.OSMIUM_CACHE !== '1') return raw

    if (!PROXIED_METHODS.includes(prop)) return raw

    const cache = new Cache()
    return new Proxy(raw, {
      async apply (target: any, thisArg: any, argArray: any[]) {
        const entry = cache.entry(prop, argArray)
        const cached = entry.get()
        switch (cached) {
          case undefined: {
            entry.set(Pending)
            console.log(`Calling \`${prop}\` with ${JSON.stringify(argArray)}`)
            const res = await target.apply(thisArg, argArray)
            entry.set({ value: res })
            return res
          }
          case Pending: {
            return new Promise(resolve => {
              const watcher = chokidar.watch(CACHE_FILE, { ignoreInitial: true })
              watcher.on('change', () => {
                const value = entry.get()
                if (value !== Pending) {
                  watcher.close().then(() => resolve(value))
                }
              })
            })
          }
          default:
            return cached
        }
      },
    })
  },
})

export default $client

const CACHE_FILE = resolve(process.cwd(), 'osmium-cache.json')
const Pending = Symbol('pending')
type CacheData = Record<string, typeof Pending | { value: any } | undefined>

class Cache {
  data!: CacheData

  constructor () {
    if (fs.existsSync(CACHE_FILE)) {
      this.read()
    } else {
      this.data = {}
      this.write()
    }
  }

  read () {
    this.data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'))
  }

  write () {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(this.data, null, 2), 'utf-8')
  }

  entry (method: keyof NotionAPI, args: any[]) {
    const key = method + JSON.stringify(args)
    return new CacheEntry(this, key)
  }
}

class CacheEntry {
  constructor (private cache: Cache, private key: string) {}

  get () {
    this.cache.read()
    const raw = this.cache.data[this.key]
    return raw === Pending ? Pending : raw?.value
  }

  set (value: any) {
    this.cache.data[this.key] = value
    this.cache.write()
  }
}
