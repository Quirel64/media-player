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

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by',
  'ost', 'original', 'soundtrack', 'sound', 'track', 'bgm', 'vol', 'volume',
  'feat', 'ft', 'featuring', 'theme', 'music', 'song', 'version', 'you'
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

export function groupTracks(tracks: Track[], opts: { minGroupSize?: number } = {}): GroupResult {
  const minGroupSize = opts.minGroupSize ?? 2
  if (tracks.length === 0) return { groups: [], loose: [], stats: { total: 0, grouped: 0, looseCount: 0 } }

  // token -> track ids
  const tokenMap = new Map<string, Set<string>>()
  const trackTokens = new Map<string, Set<string>>()

  for (const t of tracks) {
    const source = t.album !== 'Unknown Album' && t.artist !== 'Unknown Artist'
      ? `${t.artist} ${t.album} ${t.name}`
      : t.name
    const toks = new Set(tokens(source))
    trackTokens.set(t.id, toks)
    for (const tok of toks) {
      if (!tokenMap.has(tok)) tokenMap.set(tok, new Set())
      tokenMap.get(tok)!.add(t.id)
    }
  }

  // Also consider folderName grouping as baseline — skip generic/oversized
  const GENERIC = new Set(['selected files', 'unknown folder', 'downloads', 'download', 'music', 'videos', 'media'])
  const byFolder = new Map<string, Track[]>()
  for (const t of tracks) {
    const f = t.folderName || 'Unknown Folder'
    if (!byFolder.has(f)) byFolder.set(f, [])
    byFolder.get(f)!.push(t)
  }

  const groups: Group[] = []
  const tokenToGroup = new Map<string, Group>()

  // Phase 1: folder groups (only non-generic, <=60% of library)
  for (const [folder, members] of byFolder) {
    if (GENERIC.has(folder.toLowerCase().trim())) continue
    if (members.length < minGroupSize) continue
    if (members.length / tracks.length > 0.6) continue
    const g: Group = { id: `folder:${folder}`, name: folder, tracks: [...members], reason: `folder "${folder}" (${members.length})` }
    groups.push(g)
  }

  // Phase 2: token frequency -> main groups (overlap allowed)
  // Collect candidate main tokens sorted by frequency desc
  const candidates = [...tokenMap.entries()]
    .filter(([, ids]) => ids.size >= minGroupSize)
    .sort((a, b) => b[1].size - a[1].size)

  // Track set signature -> merged token names (hat+time same 7 tracks -> one group)
  const signatureToTokens = new Map<string, string[]>()
  const signatureToIds = new Map<string, Set<string>>()

  for (const [tok, ids] of candidates) {
    const sig = [...ids].sort().join('|')
    if (!signatureToTokens.has(sig)) {
      signatureToTokens.set(sig, [])
      signatureToIds.set(sig, ids)
    }
    signatureToTokens.get(sig)!.push(tok)
  }

  for (const [sig, toks] of signatureToTokens) {
    const ids = signatureToIds.get(sig)!
    if (ids.size < minGroupSize) continue
    // Use up to 2 most frequent tokens in this exact signature as name
    const name = toks.slice(0, 2).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    const memberTracks = tracks.filter((t) => ids.has(t.id))
    // Skip if this exact group already covered by a folder group with same members
    if (groups.some((g) => g.tracks.length === memberTracks.length && g.tracks.every((x) => ids.has(x.id)))) continue
    const g: Group = {
      id: `tok:${toks.slice(0, 2).join('-')}`,
      name,
      tracks: memberTracks,
      reason: `shared [${toks.slice(0, 3).join(', ')}] (${ids.size})`,
    }
    groups.push(g)
    for (const tok of toks) tokenToGroup.set(tok, g)
  }

  // Phase 3: subgroups — for each main group, find co-occurring secondary tokens
  // This keeps overlap: a track with mario+luigi appears in both mario and luigi groups
  // Subgroups are just the per-token groups above; additionally surface "shared" counts via reason
  // No extra merging — overlap is intentional per user request

  // Compute loose: tracks not in any group
  const groupedIds = new Set<string>()
  for (const g of groups) for (const t of g.tracks) groupedIds.add(t.id)

  const loose = tracks.filter((t) => !groupedIds.has(t.id))

  // Sort groups by size desc for stable Logs
  groups.sort((a, b) => b.tracks.length - a.tracks.length)

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
