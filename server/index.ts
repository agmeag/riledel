import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, opendir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type MediaKind = 'image' | 'video'
type MediaFile = {
  id: string
  name: string
  logicalName: string
  relativePath: string
  absolutePath: string
  kind: MediaKind
  size: number
  modifiedAt: string
  duplicateCount: number
}
type State = { sourceRoot?: string; lastPending?: { relativePath: string } }
type Operation = { id: string; source: string; destination: string; expiresAt: number }

const app = Fastify({ logger: true })
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const statePath = path.join(projectRoot, '.filedele-state.json')
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.svg', '.heic', '.heif', '.tif', '.tiff'])
const videoExtensions = new Set(['.mp4', '.m4v', '.mov', '.webm', '.ogv', '.avi', '.mkv', '.mts', '.m2ts', '.3gp'])
const mimeTypes: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.ogv': 'video/ogg'
}
const categories = new Set(['family', 'work', 'inspiration', 'game', 'personal', 'pets', 'documents'])
let files: MediaFile[] = []
let sourceRoot: string | undefined
let operations: Operation[] = []
let scanning = false
let scanGeneration = 0

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode })
}

async function loadState(): Promise<State> {
  try { return JSON.parse(await readFile(statePath, 'utf8')) as State } catch { return {} }
}

async function saveState(state: State) {
  await writeFile(statePath, JSON.stringify(state, null, 2))
}

function logicalName(filename: string) {
  const extension = path.extname(filename)
  return path.basename(filename, extension)
    .replace(/__fd_\d{8}-\d{6}-\d{3}_[a-z0-9]{4}$/i, '')
    .normalize('NFKC')
    .toLocaleLowerCase()
}

function idFor(filePath: string, device: number, inode: number | bigint) {
  return createHash('sha256').update(`${device}:${inode}:${filePath}`).digest('hex').slice(0, 24)
}

async function mediaFromPath(root: string, absolutePath: string, name = path.basename(absolutePath)) {
  const extension = path.extname(name).toLocaleLowerCase()
  const kind = imageExtensions.has(extension) ? 'image' : videoExtensions.has(extension) ? 'video' : undefined
  if (!kind) return null
  const details = await stat(absolutePath)
  if (!details.isFile()) return null
  return {
    id: idFor(absolutePath, details.dev, details.ino),
    name,
    logicalName: logicalName(name),
    relativePath: path.relative(root, absolutePath),
    absolutePath,
    kind,
    size: details.size,
    modifiedAt: details.mtime.toISOString(),
    duplicateCount: 1
  } satisfies MediaFile
}

function addScannedFile(file: MediaFile) {
  if (files.some(candidate => candidate.id === file.id)) return
  const matches = files.filter(candidate => candidate.logicalName === file.logicalName)
  file.duplicateCount = matches.length + 1
  for (const match of matches) match.duplicateCount = file.duplicateCount
  files.push(file)
}

async function scan(root: string, generation?: number) {
  const found: MediaFile[] = []
  async function walk(directory: string) {
    if (generation !== undefined && generation !== scanGeneration) return
    const directoryHandle = await opendir(directory)
    const entries = []
    for await (const entry of directoryHandle) entries.push(entry)
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (generation !== undefined && generation !== scanGeneration) return
      if (entry.name === '.filedele' || entry.name === '.DS_Store') continue
      const absolutePath = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const file = await mediaFromPath(root, absolutePath, entry.name)
        if (!file) continue
        if (generation === undefined) found.push(file)
        else addScannedFile(file)
      } catch (error) {
        app.log.warn({ error, absolutePath }, 'Skipped unreadable file')
      }
    }
  }
  await walk(root)
  if (generation !== undefined) return []
  const counts = new Map<string, number>()
  for (const file of found) counts.set(file.logicalName, (counts.get(file.logicalName) ?? 0) + 1)
  for (const file of found) file.duplicateCount = counts.get(file.logicalName) ?? 1
  found.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return found
}

async function startProgressiveScan(root: string, resumePath?: string) {
  const generation = ++scanGeneration
  files = []
  scanning = true
  if (resumePath) {
    try {
      const resumeFile = await mediaFromPath(root, path.resolve(root, resumePath))
      if (resumeFile && !resumeFile.relativePath.startsWith('..')) addScannedFile(resumeFile)
    } catch {}
  }
  void scan(root, generation)
    .catch(error => app.log.error({ error }, 'Background scan failed'))
    .finally(() => { if (generation === scanGeneration) scanning = false })
}

function publicFile(file: MediaFile) {
  const { absolutePath: _absolutePath, ...safe } = file
  return { ...safe, contentUrl: `/api/files/${file.id}/content` }
}

function requireFile(id: string) {
  const file = files.find(candidate => candidate.id === id)
  if (!file) throw httpError(404, 'File is no longer available')
  return file
}

async function assertInsideRoot(filePath: string) {
  if (!sourceRoot) throw httpError(400, 'Choose a source first')
  const resolvedRoot = await realpath(sourceRoot)
  const resolvedFile = await realpath(filePath)
  if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw httpError(403, 'Path is outside the selected source')
  }
}

function suffix() {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(now).reduce<Record<string, string>>((result, item) => ({ ...result, [item.type]: item.value }), {})
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}-${String(now.getMilliseconds()).padStart(3, '0')}_${randomBytes(2).toString('hex')}`
}

async function uniqueDestination(directory: string, file: MediaFile) {
  await mkdir(directory, { recursive: true })
  const extension = path.extname(file.name)
  const base = path.basename(file.name, extension).replace(/__fd_\d{8}-\d{6}-\d{3}_[a-z0-9]{4}$/i, '')
  let destination = path.join(directory, `${base}__fd_${suffix()}${extension.toLocaleLowerCase()}`)
  while (true) {
    try { await access(destination); destination = path.join(directory, `${base}__fd_${suffix()}${extension.toLocaleLowerCase()}`) }
    catch { return destination }
  }
}

async function setPending() {
  const state = await loadState()
  const next = files[0]
  await saveState({ ...state, sourceRoot, lastPending: next ? { relativePath: next.relativePath } : undefined })
}

app.get('/api/health', async () => ({ ok: true }))

app.get('/api/volumes', async () => {
  const candidates = process.platform === 'darwin' ? ['/Volumes'] : process.platform === 'win32' ? [] : ['/media', '/mnt']
  const volumes: string[] = []
  for (const base of candidates) {
    try {
      const directory = await opendir(base)
      for await (const entry of directory) if (entry.isDirectory()) volumes.push(path.join(base, entry.name))
    } catch {}
  }
  const state = await loadState()
  return { volumes, previousRoot: state.sourceRoot ?? null }
})

app.post<{ Body: { root?: string; restart?: boolean } }>('/api/session', async request => {
  if (!request.body.root) throw httpError(400, 'A source folder is required')
  const root = await realpath(request.body.root)
  const details = await stat(root)
  if (!details.isDirectory()) throw httpError(400, 'The source must be a directory')
  sourceRoot = root
  const state = await loadState()
  const resumePath = !request.body.restart && state.sourceRoot === root ? state.lastPending?.relativePath : undefined
  await saveState({ ...state, sourceRoot: root, lastPending: resumePath ? { relativePath: resumePath } : undefined })
  await startProgressiveScan(root, resumePath)
  return { root, total: files.length, files: files.slice(0, 20).map(publicFile), scanning }
})

app.get('/api/files', async () => ({ total: files.length, files: files.slice(0, 20).map(publicFile), scanning }))

app.get<{ Params: { id: string }; Headers: { range?: string } }>('/api/files/:id/content', async (request, reply) => {
  const file = requireFile(request.params.id)
  await assertInsideRoot(file.absolutePath)
  const details = await stat(file.absolutePath)
  const contentType = mimeTypes[path.extname(file.name).toLocaleLowerCase()] ?? 'application/octet-stream'
  reply.header('Accept-Ranges', 'bytes').header('Content-Type', contentType).header('Cache-Control', 'no-store')
  const match = request.headers.range?.match(/bytes=(\d+)-(\d*)/)
  if (match) {
    const start = Number(match[1])
    const end = match[2] ? Math.min(Number(match[2]), details.size - 1) : details.size - 1
    if (start > end || start >= details.size) return reply.code(416).send()
    reply.code(206).headers({ 'Content-Range': `bytes ${start}-${end}/${details.size}`, 'Content-Length': end - start + 1 })
    return reply.send(createReadStream(file.absolutePath, { start, end }))
  }
  reply.header('Content-Length', details.size)
  return reply.send(createReadStream(file.absolutePath))
})

app.post<{ Params: { id: string }; Body: { destination: 'keep' | 'delete'; category?: string } }>('/api/files/:id/move', async request => {
  const file = requireFile(request.params.id)
  await assertInsideRoot(file.absolutePath)
  const category = request.body.category
  if (category && !categories.has(category)) throw httpError(400, 'Unknown category')
  if (!sourceRoot) throw httpError(400, 'Choose a source first')
  const typeFolder = file.kind === 'image' ? '_images' : '_videos'
  const segments = [sourceRoot, '.filedele', request.body.destination, typeFolder]
  if (request.body.destination === 'keep') segments.push(`_${category ?? 'uncategorized'}`)
  const destination = await uniqueDestination(path.join(...segments), file)
  await rename(file.absolutePath, destination)
  const operation = { id: randomBytes(8).toString('hex'), source: file.absolutePath, destination, expiresAt: Date.now() + 10_000 }
  operations = [operation, ...operations].slice(0, 10)
  files = files.filter(candidate => candidate.id !== file.id)
  await setPending()
  return { operationId: operation.id, undoUntil: operation.expiresAt, next: files[0] ? publicFile(files[0]) : null, remaining: files.length }
})

app.post<{ Params: { id: string } }>('/api/operations/:id/undo', async request => {
  const operation = operations.find(candidate => candidate.id === request.params.id)
  if (!operation || Date.now() > operation.expiresAt) throw httpError(410, 'Undo has expired')
  await mkdir(path.dirname(operation.source), { recursive: true })
  await rename(operation.destination, operation.source)
  operations = operations.filter(candidate => candidate.id !== operation.id)
  if (sourceRoot) files = await scan(sourceRoot)
  await setPending()
  return { files: files.slice(0, 20).map(publicFile), remaining: files.length }
})

app.delete<{ Params: { id: string } }>('/api/files/:id', async request => {
  const file = requireFile(request.params.id)
  await assertInsideRoot(file.absolutePath)
  await rm(file.absolutePath)
  files = files.filter(candidate => candidate.id !== file.id)
  await setPending()
  return { next: files[0] ? publicFile(files[0]) : null, remaining: files.length }
})

if (process.env.NODE_ENV === 'production') {
  await app.register(fastifyStatic, { root: path.join(projectRoot, 'dist') })
  app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ message: 'Not found' }) : reply.sendFile('index.html'))
}

const port = Number(process.env.PORT ?? 3000)
await app.listen({ host: '0.0.0.0', port })
const addresses = Object.values(networkInterfaces()).flat().filter(address => address?.family === 'IPv4' && !address.internal)
for (const address of addresses) app.log.info(`Open on your phone: http://${address?.address}:${port}`)
