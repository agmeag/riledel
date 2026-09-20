import { useEffect, useRef, useState } from 'react'

type MediaFile = {
  id: string
  name: string
  relativePath: string
  kind: 'image' | 'video'
  size: number
  modifiedAt: string
  duplicateCount: number
  contentUrl: string
}

const categories = ['family', 'work', 'inspiration', 'game', 'personal', 'pets', 'documents']

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(body?.message ?? `Request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

function formatBytes(value: number) {
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`
}

export default function App() {
  const [files, setFiles] = useState<MediaFile[]>([])
  const [root, setRoot] = useState('')
  const [volumes, setVolumes] = useState<string[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [category, setCategory] = useState<string>()
  const [details, setDetails] = useState(false)
  const [error, setError] = useState<string>()
  const [undo, setUndo] = useState<{ id: string; expiresAt: number }>()
  const [drag, setDrag] = useState({ x: 0, y: 0 })
  const start = useRef<{ x: number; y: number } | undefined>(undefined)
  const undoTimer = useRef<number | undefined>(undefined)
  const current = files[0]

  useEffect(() => {
    api<{ volumes: string[]; previousRoot: string | null }>('/api/volumes')
      .then(data => { setVolumes(data.volumes); if (data.previousRoot) setRoot(data.previousRoot) })
      .catch(catchError)
      .finally(() => setLoading(false))
  }, [])

  function catchError(value: unknown) {
    setError(value instanceof Error ? value.message : 'Something went wrong')
  }

  async function begin(restart = false) {
    setLoading(true); setError(undefined)
    try {
      const result = await api<{ root: string; total: number; files: MediaFile[] }>('/api/session', {
        method: 'POST', body: JSON.stringify({ root, restart })
      })
      setRoot(result.root); setTotal(result.total); setFiles(result.files)
    } catch (value) { catchError(value) }
    finally { setLoading(false) }
  }

  async function move(destination: 'keep' | 'delete') {
    if (!current || working) return
    setWorking(true); setError(undefined)
    try {
      const result = await api<{ operationId: string; undoUntil: number; next: MediaFile | null; remaining: number }>(`/api/files/${current.id}/move`, {
        method: 'POST', body: JSON.stringify({ destination, category: destination === 'keep' ? category : undefined })
      })
      const nextFiles = files.slice(1)
      if (result.next && !nextFiles.some(file => file.id === result.next?.id)) nextFiles.unshift(result.next)
      setFiles(nextFiles); setTotal(result.remaining); setCategory(undefined); setDetails(false); setDrag({ x: 0, y: 0 })
      setUndo({ id: result.operationId, expiresAt: result.undoUntil })
      window.clearTimeout(undoTimer.current)
      undoTimer.current = window.setTimeout(() => setUndo(undefined), Math.max(0, result.undoUntil - Date.now()))
    } catch (value) { catchError(value); setDrag({ x: 0, y: 0 }) }
    finally { setWorking(false) }
  }

  async function undoMove() {
    if (!undo || working) return
    setWorking(true)
    try {
      const result = await api<{ files: MediaFile[]; remaining: number }>(`/api/operations/${undo.id}/undo`, { method: 'POST' })
      setFiles(result.files); setTotal(result.remaining); setUndo(undefined)
    } catch (value) { catchError(value) }
    finally { setWorking(false) }
  }

  async function hardDelete() {
    if (!current || working || !window.confirm(`Permanently delete “${current.name}”? This cannot be undone.`)) return
    setWorking(true)
    try {
      const result = await api<{ next: MediaFile | null; remaining: number }>(`/api/files/${current.id}`, { method: 'DELETE' })
      const nextFiles = files.slice(1)
      if (result.next && !nextFiles.some(file => file.id === result.next?.id)) nextFiles.unshift(result.next)
      setFiles(nextFiles); setTotal(result.remaining); setDetails(false)
    } catch (value) { catchError(value) }
    finally { setWorking(false) }
  }

  function pointerDown(event: React.PointerEvent) {
    if (working || details) return
    start.current = { x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function pointerMove(event: React.PointerEvent) {
    if (!start.current || working || details) return
    setDrag({ x: event.clientX - start.current.x, y: event.clientY - start.current.y })
  }

  function pointerUp() {
    if (!start.current) return
    const widthThreshold = window.innerWidth * 0.28
    if (drag.x > widthThreshold) void move('keep')
    else if (drag.x < -widthThreshold) void move('delete')
    else if (drag.y < -90 && Math.abs(drag.x) < 80) { setDetails(true); setDrag({ x: 0, y: 0 }) }
    else setDrag({ x: 0, y: 0 })
    start.current = undefined
  }

  if (!current && !total) {
    return <main className="setup">
      <section className="setup-card">
        <div className="brand"><span>F</span> filedele</div>
        <h1>{loading ? 'Finding your drives…' : files.length === 0 && root ? 'All clear.' : 'Choose what to clean.'}</h1>
        <p>Review your media locally. Nothing leaves this computer.</p>
        <label>Folder on your SSD</label>
        <input value={root} onChange={event => setRoot(event.target.value)} placeholder="/Volumes/My SSD" />
        {volumes.length > 0 && <div className="volume-list">{volumes.map(volume => <button key={volume} onClick={() => setRoot(volume)}>{volume}</button>)}</div>}
        <button className="primary" disabled={!root || loading} onClick={() => void begin()}>{loading ? 'Scanning…' : root && total === 0 ? 'Scan again' : 'Start reviewing'}</button>
        {root && <button className="subtle" disabled={loading} onClick={() => void begin(true)}>Start from beginning</button>}
        {error && <p className="error">{error}</p>}
      </section>
    </main>
  }

  return <main className="review">
    <header>
      <div className="brand"><span>F</span> filedele</div>
      <div className="count"><strong>{total}</strong> left</div>
    </header>

    {current && <section className="stage">
      <div className={`intent delete-intent ${drag.x < -20 ? 'visible' : ''}`}><b>DELETE</b><small>move to review bin</small></div>
      <div className={`intent keep-intent ${drag.x > 20 ? 'visible' : ''}`}><b>KEEP</b><small>{category ? `in _${category}` : 'uncategorized'}</small></div>
      <article
        className={`media-card ${working ? 'working' : ''}`}
        style={{ transform: `translate3d(${drag.x}px, ${Math.min(0, drag.y)}px, 0) rotate(${drag.x / 28}deg)` }}
        onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}
      >
        <div className="media-frame">
          {current.kind === 'image'
            ? <img src={current.contentUrl} alt={current.name} draggable={false} />
            : <video src={current.contentUrl} controls playsInline preload="metadata" onPointerDown={event => event.stopPropagation()} />}
          <div className="top-badges">
            <span>{current.kind}</span>
            {current.duplicateCount > 1 && <span className="duplicate">{current.duplicateCount} same-name files</span>}
          </div>
          <div className="file-caption"><strong>{current.name}</strong><small>{current.relativePath}</small></div>
        </div>
      </article>
    </section>}

    <section className="tags" aria-label="Keep category">
      {categories.map(item => <button className={category === item ? 'selected' : ''} key={item} onClick={() => setCategory(category === item ? undefined : item)}>_{item}</button>)}
    </section>

    <nav className="actions">
      <button className="circle destructive" onClick={() => void hardDelete()} aria-label="Delete permanently">⌫</button>
      <button className="circle delete" onClick={() => void move('delete')} aria-label="Move to delete">×</button>
      <button className="circle details" onClick={() => setDetails(true)} aria-label="Show details">i</button>
      <button className="circle keep" onClick={() => void move('keep')} aria-label="Keep">✓</button>
    </nav>

    {undo && <button className="undo" onClick={() => void undoMove()}>Moved · Undo</button>}
    {error && <div className="toast error">{error}<button onClick={() => setError(undefined)}>×</button></div>}

    {details && current && <div className="sheet-backdrop" onClick={() => setDetails(false)}>
      <section className="sheet" onClick={event => event.stopPropagation()}>
        <div className="grabber" />
        <h2>File details</h2>
        <dl>
          <div><dt>Name</dt><dd>{current.name}</dd></div>
          <div><dt>Location</dt><dd>{current.relativePath}</dd></div>
          <div><dt>Size</dt><dd>{formatBytes(current.size)}</dd></div>
          <div><dt>Modified</dt><dd>{new Date(current.modifiedAt).toLocaleString()}</dd></div>
          <div><dt>Type</dt><dd>{current.kind}</dd></div>
          <div><dt>Name matches</dt><dd>{current.duplicateCount}</dd></div>
        </dl>
        <button className="primary" onClick={() => setDetails(false)}>Done</button>
      </section>
    </div>}
  </main>
}
