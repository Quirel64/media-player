import type { Track } from './types'

export interface Group {
  id: string
  name: string
  tracks: Track[]
  reason: string
}

export interface GroupResult {
  groups: Group[]
  loose: Track[]
  stats: { total: number; grouped: number; looseCount: number }
}

// Stop words — too common to form a group on their own
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by',
  'ost', 'original', 'soundtrack', 'sound', 'track', 'ost', 'bgm', 'vol', 'volume',
])

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\[\]\(\)\{\}【】「」]/g, ' ')
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokens(name: string): string[] {
  return normalize(name)
    .split(/[\s-]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t))
}

function commonPrefix(a: string, b: string): string {
  const na = normalize(a), nb = normalize(b)
  let i = 0
  while (i < na.length && i < nb.length && na[i] === nb[i]) i++
  // Trim to last word boundary
  const p = na.slice(0, i).trimEnd()
  const lastSpace = p.lastIndexOf(' ')
  if (lastSpace > 0) return p.slice(0, lastSpace).trim()
  return p
}

function groupNameFromPrefix(prefix: string, fallback: string): string {
  const t = prefix.trim()
  if (t.length >= 4) return t.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  return fallback
}

export function groupTracks(tracks: Track[], opts: { minGroupSize?: number; minPrefixLen?: number } = {}): GroupResult {
  const minGroupSize = opts.minGroupSize ?? 2
  const minPrefixLen = opts.minPrefixLen ?? 10

  if (tracks.length === 0) return { groups: [], loose: [], stats: { total: 0, grouped: 0, looseCount: 0 } }

  // Build track -> tokens
  const tokenMap = new Map<string, Set<string>>()
  for (const t of tracks) {
    // Prefer album/artist if not Unknown, else name tokens
    const source = t.album !== 'Unknown Album' && t.artist !== 'Unknown Artist'
      ? `${t.artist} ${t.album} ${t.name}`
      : t.name
    tokenMap.set(t.id, new Set(tokens(source)))
  }

  // Also consider folderName grouping as baseline — tracks in same folderName already share a natural group
  const byFolder = new Map<string, Track[]>()
  for (const t of tracks) {
    const f = t.folderName || 'Unknown Folder'
    if (!byFolder.has(f)) byFolder.set(f, [])
    byFolder.get(f)!.push(t)
  }

  const used = new Set<string>()
  const groups: Group[] = []

  // Phase 1: folder groups with >= minGroupSize — skip generic/oversized folders (e.g. Downloads with 100%)
  const GENERIC = new Set(['selected files', 'unknown folder', 'downloads', 'download', 'music', 'videos', 'media'])
  for (const [folder, members] of byFolder) {
    const normFolder = folder.toLowerCase().trim()
    if (GENERIC.has(normFolder)) continue
    if (members.length < minGroupSize) continue
    // If one folder holds >60% of library it's not a useful album (e.g. everything in Downloads)
    if (members.length / tracks.length > 0.6) continue
    for (const m of members) used.add(m.id)
    groups.push({
      id: `folder:${folder}`,
      name: folder,
      tracks: members,
      reason: `folder "${folder}" (${members.length})`,
    })
  }

  // Phase 2: filename common-words / prefix clustering on remaining
  const remaining = tracks.filter((t) => !used.has(t.id))
  if (remaining.length >= 2) {
    // Precompute token intersections
    const clusters: Map<string, Track[]> = new Map()

    for (let i = 0; i < remaining.length; i++) {
      for (let j = i + 1; j < remaining.length; j++) {
        const a = remaining[i], b = remaining[j]
        if (used.has(a.id) || used.has(b.id)) continue

        const ta = tokenMap.get(a.id)!, tb = tokenMap.get(b.id)!
        const shared = [...ta].filter((x) => tb.has(x))
        const prefix = commonPrefix(a.name, b.name)

        // Heuristic: 2+ shared significant tokens OR long common prefix
        const isGroup = shared.length >= 2 || prefix.length >= minPrefixLen

        if (!isGroup) continue

        // Derive group key from shared tokens or prefix
        const key = shared.length >= 2
          ? shared.sort().slice(0, 3).join(' ')
          : prefix.toLowerCase()

        if (!clusters.has(key)) clusters.set(key, [])
        const bucket = clusters.get(key)!
        if (!bucket.find((x) => x.id === a.id)) bucket.push(a)
        if (!bucket.find((x) => x.id === b.id)) bucket.push(b)
      }
    }

    // Merge overlapping clusters (tracks appearing in multiple keys)
    const merged: Track[][] = []
    for (const [, bucket] of clusters) {
      if (bucket.length < minGroupSize) continue
      // Check if bucket overlaps an existing merged group
      let target: Track[] | null = null
      for (const g of merged) {
        if (g.some((x) => bucket.some((y) => y.id === x.id))) { target = g; break }
      }
      if (target) {
        for (const t of bucket) if (!target.find((x) => x.id === t.id)) target.push(t)
      } else {
        merged.push([...bucket])
      }
    }

    // Filter small after merge and create groups
    for (const bucket of merged) {
      if (bucket.length < minGroupSize) continue
      // Skip if already covered by folder groups
      const fresh = bucket.filter((t) => !used.has(t.id))
      if (fresh.length < minGroupSize && bucket.some((t) => used.has(t.id))) {
        // Partial overlap with folder groups — skip to avoid double-count
        const newOnly = fresh.filter((t) => !used.has(t.id))
        if (newOnly.length < minGroupSize) continue
      }
      // Derive display name from longest common prefix among members
      let prefix = normalize(fresh[0]?.name ?? bucket[0].name)
      for (let k = 1; k < fresh.length; k++) prefix = commonPrefix(prefix, fresh[k].name)
      if (prefix.length < 4) prefix = fresh[0]?.name.slice(0, 20) ?? bucket[0].name.slice(0, 20)
      const name = groupNameFromPrefix(prefix, fresh[0]?.name ?? bucket[0].name)
      const finalTracks = fresh.length >= minGroupSize ? fresh : bucket.filter((t) => !used.has(t.id))
      if (finalTracks.length < minGroupSize) continue
      for (const t of finalTracks) used.add(t.id)
      const sharedTokens = [...(tokenMap.get(finalTracks[0].id) ?? new Set())].filter((x) =>
        finalTracks.every((tr) => tokenMap.get(tr.id)?.has(x))
      )
      groups.push({
        id: `auto:${name.toLowerCase()}`,
        name,
        tracks: finalTracks,
        reason: sharedTokens.length ? `shared [${sharedTokens.slice(0, 3).join(', ')}]` : `prefix "${prefix.slice(0, 24)}"`,
      })
    }
  }

  const loose = tracks.filter((t) => !used.has(t.id))
  return {
    groups,
    loose,
    stats: { total: tracks.length, grouped: tracks.length - loose.length, looseCount: loose.length },
  }
}

export function describeGroups(r: GroupResult): string {
  const lines: string[] = []
  lines.push(`Groups: ${r.groups.length} | Grouped: ${r.stats.grouped}/${r.stats.total} | Loose: ${r.stats.looseCount}`)
  for (const g of r.groups) {
    lines.push(`- "${g.name}" (${g.tracks.length}) [${g.reason}] -> ${g.tracks.map((t) => t.name).join(' | ')}`)
  }
  if (r.loose.length > 0) {
    lines.push(`Loose (${r.loose.length}): ${r.loose.slice(0, 10).map((t) => t.name).join(' | ')}${r.loose.length > 10 ? ' ...' : ''}`)
  }
  return lines.join('\n')
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { groupTracks: typeof groupTracks; describeGroups: typeof describeGroups }).groupTracks = groupTracks
  ;(window as unknown as { describeGroups: typeof describeGroups }).describeGroups = describeGroups
}
