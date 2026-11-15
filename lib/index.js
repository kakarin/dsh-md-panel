/**
 * dsh-md-panel —— 宿主半：知识库索引、实时扫描、同源 API。
 *
 * 干四件事：
 *   1. 扫描知识库根目录（默认 ~/KnowledgeBase，可用 config.root 或环境变量
 *      DSH_KB_ROOT 覆盖），
 *      为每个 .md 建立轻量索引：路径、大小、mtime、frontmatter(type/updated/status/tags)、
 *      标题、摘要、字数；
 *   2. 每 pollIntervalMs 扫一次指纹（路径|大小|mtime），有变化就通过 SSE
 *      (/md-panel/api/events) 推给浏览器，前端据此刷新树与当前文档 —— 这就是「实时同步」；
 *   3. 提供同源 HTTP 接口：tree / file / search / asset / timeline / events / open / status；
 *   4. 打开文件管理器（xdg-open 所在的目录），供面板的「在本机打开」按钮用。
 *
 * 只 import node: 内置模块，不引第三方包；所有路径都夹在知识库根目录里，防穿越。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const name = 'md-panel'

/** webServer 提供同源 API；fs/tools 不强制，保持最小依赖。 */
export const inject = ['webServer']

const PLUGIN_ID = 'dsh-md-panel'
const API_PREFIX = '/md-panel/api'
const DEFAULT_ROOT = process.env.DSH_KB_ROOT || path.join(os.homedir(), 'KnowledgeBase')
const MD_EXT = new Set(['.md', '.markdown', '.mdx'])
// 目录整体跳过：工具目录 + 塞进知识库里的第三方仓库/构建产物（它们不是知识条目）
const SKIP_DIR = new Set([
  '.git', '.obsidian', '.plume', '.trash', '.stfolder', '@eaDir',
  'node_modules', 'repos', 'vendor', 'third_party', 'third-party', 'dist', 'build',
])

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
}

// ---- 文本解析 ------------------------------------------------------------

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** 解析 frontmatter：支持 `key: value`、`key: [a, b]`、多行 `- item` 列表。 */
function parseFrontmatter(text) {
  const match = FRONTMATTER_RE.exec(text)
  if (match === null) return { data: {}, body: text }
  const data = {}
  let currentKey = ''
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const listItem = /^\s*-\s+(.*)$/.exec(line)
    if (listItem !== null && currentKey !== '') {
      const value = stripQuotes(listItem[1].trim())
      const bucket = Array.isArray(data[currentKey]) ? data[currentKey] : []
      bucket.push(value)
      data[currentKey] = bucket
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    if (key === '') continue
    currentKey = key
    if (value === '') {
      data[key] = []
      continue
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((item) => stripQuotes(item.trim()))
        .filter((item) => item !== '')
      continue
    }
    if (value === 'true' || value === 'false') {
      data[key] = value === 'true'
      continue
    }
    data[key] = stripQuotes(value)
  }
  return { data, body: text.slice(match[0].length) }
}

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}

/** 第一行 `# 标题`；没有就退回文件名。 */
function pickTitle(body, name) {
  const match = /^#[ \t]+(.+)$/m.exec(body)
  if (match !== null) return match[1].trim()
  return name.replace(/\.(md|markdown|mdx)$/i, '')
}

/** 正文第一段非空、非标题、非表格的纯文本，最长 160 字。 */
function pickExcerpt(body) {
  const lines = body.split(/\r?\n/)
  const chunks = []
  let inFence = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('|') || trimmed.startsWith('<!--')) continue
    chunks.push(trimmed.replace(/^[-*+>]\s+/, '').replace(/[*`_]/g, ''))
    if (chunks.join(' ').length >= 160) break
  }
  return chunks.join(' ').slice(0, 160)
}

function countWords(body) {
  const cjk = (body.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length
  const words = (body.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[A-Za-z0-9_]+/g) ?? []).length
  return cjk + words
}

/** 极简稳定 hash，用来判断「这一批文件是不是变了」。 */
function hashString(input) {
  let hash = 5381
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

function toPosix(value) {
  return value.split(path.sep).join('/')
}

// ---- 插件主体 ------------------------------------------------------------

export function apply(ctx, config = {}) {
  const root = path.resolve(typeof config.root === 'string' && config.root !== '' ? config.root : DEFAULT_ROOT)
  const pollMs = clampNumber(config.pollIntervalMs ?? 2000, 500, 60000)

  const state = {
    files: new Map(), // relPath -> entry
    dirs: new Set(), // relDir（'' 表示根）
    version: '',
    builtAt: 0,
    lastScanAt: 0,
    lastChangeAt: 0,
    scanMs: 0,
    scanning: false,
    error: '',
    sseClients: new Set(),
    textCache: new Map(), // relPath -> { mtime, text }
    timers: [],
  }

  const log = (...args) => {
    if (config.verbose === true) console.log(`[${PLUGIN_ID}]`, ...args)
  }

  // -- 扫描 ----------------------------------------------------------------

  async function walk() {
    const files = new Map()
    const dirs = new Set([''])
    const queue = ['']
    while (queue.length > 0) {
      const relDir = queue.shift()
      const absDir = relDir === '' ? root : path.join(root, relDir)
      let entries
      try {
        entries = await fs.readdir(absDir, { withFileTypes: true })
      } catch (error) {
        if (relDir === '' && state.error !== String(error.message ?? error)) {
          state.error = String(error.message ?? error)
          console.error(`[${PLUGIN_ID}] 读取知识库根目录失败:`, state.error)
        }
        continue
      }
      for (const entry of entries) {
        const entryName = entry.name
        if (entryName.startsWith('.')) continue
        if (SKIP_DIR.has(entryName)) continue
        const rel = relDir === '' ? entryName : `${relDir}/${entryName}`
        if (entry.isDirectory()) {
          dirs.add(rel)
          queue.push(rel)
          continue
        }
        if (!entry.isFile()) continue
        const ext = path.extname(entryName).toLowerCase()
        if (!MD_EXT.has(ext)) continue
        let stat
        try {
          stat = await fs.stat(path.join(root, rel))
        } catch {
          continue
        }
        files.set(rel, {
          path: rel,
          name: entryName,
          stem: entryName.replace(/\.(md|markdown|mdx)$/i, ''),
          dir: relDir,
          size: stat.size,
          mtime: Math.round(stat.mtimeMs),
          fingerprint: `${stat.size}:${Math.round(stat.mtimeMs)}`,
        })
      }
    }
    return { files, dirs }
  }

  async function enrich(entry, previous) {
    const same = previous !== undefined && previous.fingerprint === entry.fingerprint
    const text = same ? (await readTextCached(entry)) ?? '' : (await readTextCached(entry, true)) ?? ''
    const { data, body } = parseFrontmatter(text)
    const next = {
      ...entry,
      title: pickTitle(body, entry.name),
      excerpt: pickExcerpt(body),
      words: countWords(body),
      type: typeof data.type === 'string' ? data.type : '',
      status: typeof data.status === 'string' ? data.status : '',
      updated: typeof data.updated === 'string' ? data.updated : '',
      tags: Array.isArray(data.tags) ? data.tags : typeof data.tags === 'string' && data.tags !== '' ? [data.tags] : [],
      frontmatter: data,
      bodyLength: body.length,
      // 树里也标记一下 frontmatter 是否合规（跟 KB 规则同一套判断）
      issues: frontmatterIssues(data, entry.path),
    }
    return next
  }

  function frontmatterIssues(data, relPath) {
    const issues = []
    if (relPath.startsWith('99-模板/')) return issues
    if (relPath === 'Rule.md' || relPath === 'README.md') return issues
    if (typeof data.type !== 'string' || data.type === '') issues.push('缺 type')
    if (typeof data.updated !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.updated)) issues.push('缺 updated')
    if (data.type === 'device' || data.type === 'service') {
      if (typeof data.status !== 'string' || data.status === '') issues.push('缺 status')
    }
    return issues
  }

  async function readTextCached(entry, force = false) {
    const cached = state.textCache.get(entry.path)
    if (force !== true && cached !== undefined && cached.mtime === entry.mtime) return cached.text
    try {
      const text = await fs.readFile(path.join(root, entry.path), 'utf8')
      state.textCache.set(entry.path, { mtime: entry.mtime, text })
      return text
    } catch {
      state.textCache.delete(entry.path)
      return undefined
    }
  }

  async function scan(reason) {
    if (state.scanning) return undefined
    state.scanning = true
    const startedAt = Date.now()
    try {
      const { files, dirs } = await walk()
      const previous = state.files
      let added = 0
      let changed = 0
      let removed = 0
      for (const relPath of previous.keys()) {
        if (!files.has(relPath)) {
          removed += 1
          state.textCache.delete(relPath)
        }
      }
      for (const [relPath, entry] of files.entries()) {
        const before = previous.get(relPath)
        if (before === undefined) added += 1
        else if (before.fingerprint !== entry.fingerprint) changed += 1
      }
      const fingerprints = JSON.stringify([...files.keys()].sort().map((key) => {
        const entry = files.get(key)
        return `${key}|${entry.fingerprint}`
      }))
      const version = hashString(fingerprints)
      const isFirst = state.version === ''
      state.version = version
      state.dirs = dirs
      state.builtAt = Date.now()
      state.lastScanAt = state.builtAt
      state.scanMs = state.lastScanAt - startedAt

      const pending = []
      for (const [relPath, entry] of files.entries()) {
        const before = previous.get(relPath)
        if (before !== undefined && before.fingerprint === entry.fingerprint) {
          pending.push(before)
          continue
        }
        pending.push(await enrich(entry, before))
      }
      state.files = new Map(pending.map((entry) => [entry.path, entry]))

      if (isFirst === false && (added > 0 || changed > 0 || removed > 0)) {
        state.lastChangeAt = Date.now()
        broadcast({
          type: 'change',
          version,
          added,
          changed,
          removed,
          at: state.lastChangeAt,
          reason: typeof reason === 'string' ? reason : 'poll',
        })
        log('变更已推送', { added, changed, removed })
      }
      return { added, changed, removed, version }
    } catch (error) {
      state.error = String(error?.message ?? error)
      console.error(`[${PLUGIN_ID}] 扫描失败:`, state.error)
      return undefined
    } finally {
      state.scanning = false
    }
  }

  // -- SSE ----------------------------------------------------------------

  function broadcast(payload) {
    const frame = `data: ${JSON.stringify(payload)}\n\n`
    for (const client of state.sseClients) {
      try {
        client.write(frame)
      } catch {
        state.sseClients.delete(client)
      }
    }
  }

  function handleEvents(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(`retry: 3000\n\n`)
    res.write(`data: ${JSON.stringify({ type: 'hello', version: state.version, count: state.files.size, at: Date.now() })}\n\n`)
    state.sseClients.add(res)
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        state.sseClients.delete(res)
        clearInterval(heartbeat)
      }
    }, 20000)
    if (typeof heartbeat.unref === 'function') heartbeat.unref()
    const cleanup = () => {
      clearInterval(heartbeat)
      state.sseClients.delete(res)
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
    res.on('close', cleanup)
  }

  // -- HTTP 工具 -----------------------------------------------------------

  function safeAbs(relPath) {
    const cleaned = String(relPath ?? '').replace(/^[/\\]+/, '')
    const abs = path.resolve(root, cleaned)
    if (abs !== root && !abs.startsWith(root + path.sep)) return undefined
    return abs
  }

  function sendJson(res, status, body) {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(payload)
  }

  function sendError(res, status, message) {
    sendJson(res, status, { ok: false, error: message })
  }

  async function readBody(req, limit = 64 * 1024) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) return undefined
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return undefined
    }
  }

  function fileEntry(entry) {
    return {
      path: entry.path,
      name: entry.name,
      stem: entry.stem,
      dir: entry.dir,
      size: entry.size,
      mtime: entry.mtime,
      title: entry.title,
      excerpt: entry.excerpt,
      words: entry.words,
      type: entry.type,
      status: entry.status,
      updated: entry.updated,
      tags: entry.tags,
      issues: entry.issues,
    }
  }

  function treePayload() {
    const dirs = [...state.dirs].sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))
    const files = [...state.files.values()]
      .map(fileEntry)
      .sort((left, right) => left.path.localeCompare(right.path, 'zh-Hans-CN'))
    const types = new Map()
    const tags = new Map()
    let issues = 0
    for (const file of files) {
      types.set(file.type === '' ? '(未标注)' : file.type, (types.get(file.type === '' ? '(未标注)' : file.type) ?? 0) + 1)
      for (const tag of file.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1)
      if (file.issues.length > 0) issues += 1
    }
    return {
      ok: true,
      root,
      version: state.version,
      count: files.length,
      scannedAt: state.lastScanAt,
      changedAt: state.lastChangeAt,
      scanMs: state.scanMs,
      error: state.error,
      dirs,
      files,
      types: [...types.entries()].sort((left, right) => right[1] - left[1]).map(([key, value]) => ({ key, count: value })),
      tags: [...tags.entries()].sort((left, right) => right[1] - left[1]).slice(0, 40).map(([key, value]) => ({ key, count: value })),
      issues,
    }
  }

  // -- 链接分析 ------------------------------------------------------------

  const WIKI_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g
  const MD_LINK_RE = /\[([^\]]*)\]\(([^)\s]+?\.md(?:#[^)]*)?)\)/g

  function normalizeTarget(fromRel, target) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined
    const hashIndex = target.indexOf('#')
    const bare = hashIndex >= 0 ? target.slice(0, hashIndex) : target
    if (bare === '') return undefined
    const decoded = decodeURI(bare)
    const baseDir = path.posix.dirname(fromRel)
    const joined = decoded.startsWith('/') ? decoded.slice(1) : path.posix.join(baseDir === '.' ? '' : baseDir, decoded)
    const normalized = path.posix.normalize(joined)
    if (normalized.startsWith('..')) return undefined
    return normalized
  }

  function analyzeLinks(relPath, body) {
    const links = []
    const seen = new Set()
    for (const match of body.matchAll(WIKI_RE)) {
      const target = match[1].trim()
      if (target === '') continue
      const candidates = [normalizeTarget(relPath, target + '.md'), normalizeTarget(relPath, target)]
      const hit = candidates.find((candidate) => candidate !== undefined && state.files.has(candidate))
      const key = `wiki:${target}`
      if (seen.has(key)) continue
      seen.add(key)
      links.push({ kind: 'wiki', label: (match[2] ?? target).trim(), target: hit ?? target, resolved: hit !== undefined })
    }
    for (const match of body.matchAll(MD_LINK_RE)) {
      const rawTarget = match[2]
      const resolved = normalizeTarget(relPath, rawTarget)
      const key = `md:${rawTarget}`
      if (seen.has(key)) continue
      seen.add(key)
      links.push({
        kind: 'md',
        label: match[1].trim() === '' ? rawTarget : match[1].trim(),
        target: resolved ?? rawTarget,
        resolved: resolved !== undefined && state.files.has(resolved),
      })
    }
    return links
  }

  function backlinksOf(relPath) {
    const stem = path.posix.basename(relPath).replace(/\.(md|markdown|mdx)$/i, '')
    const hits = []
    for (const entry of state.files.values()) {
      if (entry.path === relPath) continue
      const cached = state.textCache.get(entry.path)
      if (cached === undefined) continue
      const text = cached.text
      const mentions =
        text.includes(`[[${stem}]]`) ||
        text.includes(`[[${stem}|`) ||
        text.includes(`/${path.posix.basename(relPath)}`) ||
        text.includes(`(${path.posix.basename(relPath)})`) ||
        text.includes(`/${stem}]`)
      if (!mentions) continue
      const links = analyzeLinks(entry.path, text)
      if (links.some((link) => link.resolved && link.target === relPath)) hits.push({ path: entry.path, title: entry.title })
      else if (text.includes(`[[${stem}`) || text.includes(path.posix.basename(relPath))) hits.push({ path: entry.path, title: entry.title })
    }
    return hits.slice(0, 50)
  }

  // -- 搜索 ----------------------------------------------------------------

  function search(query, limit) {
    const terms = String(query ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term !== '')
    if (terms.length === 0) return []
    const results = []
    for (const entry of state.files.values()) {
      const cached = state.textCache.get(entry.path)
      if (cached === undefined) continue
      const text = cached.text
      const lower = text.toLowerCase()
      let score = 0
      for (const term of terms) {
        let from = 0
        let hits = 0
        while (hits < 40) {
          const index = lower.indexOf(term, from)
          if (index < 0) break
          hits += 1
          from = index + term.length
        }
        if (hits === 0) {
          score = 0
          break
        }
        score += Math.min(hits, 12)
      }
      const titleHit = terms.every((term) => entry.title.toLowerCase().includes(term)) ? 8 : 0
      const pathHit = terms.every((term) => entry.path.toLowerCase().includes(term)) ? 5 : 0
      if (score === 0 && titleHit === 0 && pathHit === 0) continue
      const matches = []
      const lines = text.split(/\r?\n/)
      for (let index = 0; index < lines.length && matches.length < 4; index += 1) {
        const line = lines[index]
        const lowerLine = line.toLowerCase()
        if (terms.every((term) => lowerLine.includes(term))) {
          matches.push({ line: index + 1, text: line.trim().slice(0, 220) })
        }
      }
      results.push({
        path: entry.path,
        title: entry.title,
        dir: entry.dir,
        type: entry.type,
        mtime: entry.mtime,
        score: score + titleHit + pathHit,
        matches,
      })
    }
    results.sort((left, right) => right.score - left.score || right.mtime - left.mtime)
    return results.slice(0, clampNumber(limit ?? 40, 1, 200))
  }

  // -- 路由 ----------------------------------------------------------------

  async function handleApi(req, res) {
    const url = new URL(req.url ?? '/', 'http://dsh.local')
    const route = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : ''
    const method = (req.method ?? 'GET').toUpperCase()

    if (route === '/events' && method === 'GET') {
      handleEvents(req, res)
      return
    }

    if (route === '/status' && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        root,
        version: state.version,
        count: state.files.size,
        dirs: state.dirs.size,
        scannedAt: state.lastScanAt,
        changedAt: state.lastChangeAt,
        scanMs: state.scanMs,
        pollMs,
        clients: state.sseClients.size,
        error: state.error,
      })
      return
    }

    if (route === '/tree' && method === 'GET') {
      if (state.version === '') await scan('tree-request')
      sendJson(res, 200, treePayload())
      return
    }

    if (route === '/timeline' && method === 'GET') {
      const limit = clampNumber(Number(url.searchParams.get('limit') ?? 60), 1, 200)
      const files = [...state.files.values()]
        .sort((left, right) => right.mtime - left.mtime)
        .slice(0, limit)
        .map(fileEntry)
      sendJson(res, 200, { ok: true, at: state.lastScanAt, files })
      return
    }

    if (route === '/search' && method === 'GET') {
      const query = url.searchParams.get('q') ?? ''
      const limit = Number(url.searchParams.get('limit') ?? 40)
      if (state.version === '') await scan('search-request')
      const startedAt = Date.now()
      const hits = search(query, limit)
      sendJson(res, 200, { ok: true, query, tookMs: Date.now() - startedAt, hits })
      return
    }

    if (route === '/file' && method === 'GET') {
      const relPath = url.searchParams.get('path') ?? ''
      const abs = safeAbs(relPath)
      if (abs === undefined) {
        sendError(res, 400, '路径越界')
        return
      }
      const entry = state.files.get(path.posix.normalize(relPath.split(path.sep).join('/')).replace(/^\.\//, ''))
      if (entry === undefined) {
        sendError(res, 404, `知识库里没有这个文件：${relPath}`)
        return
      }
      const text = (await readTextCached(entry, true)) ?? ''
      const { data, body } = parseFrontmatter(text)
      sendJson(res, 200, {
        ok: true,
        path: entry.path,
        name: entry.name,
        dir: entry.dir,
        size: entry.size,
        mtime: entry.mtime,
        title: pickTitle(body, entry.name),
        frontmatter: data,
        raw: text,
        body,
        words: countWords(body),
        links: analyzeLinks(entry.path, body),
        backlinks: backlinksOf(entry.path),
        issues: frontmatterIssues(data, entry.path),
        version: state.version,
      })
      return
    }

    if (route === '/asset' && method === 'GET') {
      const relPath = url.searchParams.get('path') ?? ''
      const abs = safeAbs(relPath)
      if (abs === undefined) {
        sendError(res, 400, '路径越界')
        return
      }
      let stat
      try {
        stat = await fs.stat(abs)
      } catch {
        sendError(res, 404, '资源不存在')
        return
      }
      if (!stat.isFile()) {
        sendError(res, 404, '资源不存在')
        return
      }
      const mime = MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream'
      const data = await fs.readFile(abs)
      res.writeHead(200, {
        'content-type': mime,
        'content-length': String(data.length),
        'cache-control': 'no-store',
      })
      res.end(data)
      return
    }

    if (route === '/open' && method === 'POST') {
      const body = await readBody(req)
      if (body === undefined) {
        sendError(res, 400, '请求体不是合法 JSON')
        return
      }
      const relPath = typeof body.path === 'string' ? body.path : ''
      const abs = safeAbs(relPath)
      if (abs === undefined) {
        sendError(res, 400, '路径越界')
        return
      }
      const target = abs === root ? root : abs
      const mode = body.mode === 'file' ? 'file' : 'reveal'
      const arg = mode === 'file' ? target : path.dirname(target)
      const result = await openInFileManager(arg)
      sendJson(res, 200, { ok: true, mode, opened: arg, ...result })
      return
    }

    if (route === '/rescan' && method === 'POST') {
      const changes = await scan('manual')
      sendJson(res, 200, { ok: true, changes, ...treePayload() })
      return
    }

    sendError(res, 404, `未知接口：${route}`)
  }

  function openInFileManager(target) {
    const candidates = [
      ['xdg-open', [target]],
      ['gio', ['open', target]],
      ['nautilus', [target]],
      ['dolphin', [target]],
      ['thunar', [target]],
      ['explorer.exe', [target]],
      ['open', [target]],
    ]
    for (const [command, args] of candidates) {
      try {
        const child = spawn(command, args, { detached: true, stdio: 'ignore' })
        child.on('error', () => {})
        child.unref()
        return { command }
      } catch {
        continue
      }
    }
    return { command: undefined }
  }

  // -- 生命周期 ------------------------------------------------------------

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        await handleApi(req, res)
      } catch (error) {
        console.error(`[${PLUGIN_ID}] API 失败:`, error)
        if (!res.headersSent) sendError(res, 500, String(error?.message ?? error))
        else res.end()
      }
    },
  }), `${PLUGIN_ID}: /md-panel/api routes`)

  // 首次扫描（不阻塞插件加载）
  scan('bootstrap').then(() => log('首次扫描完成', { count: state.files.size, ms: state.scanMs }))

  const timer = setInterval(() => {
    scan('poll')
  }, pollMs)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.effect(() => () => {
    clearInterval(timer)
    for (const client of state.sseClients) {
      try {
        client.end()
      } catch {
        // 已经断了
      }
    }
    state.sseClients.clear()
  }, `${PLUGIN_ID}: 扫描器与 SSE 收尾`)

  log('已启动', { root, pollMs })
}

function clampNumber(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.min(Math.max(number, min), max)
}
