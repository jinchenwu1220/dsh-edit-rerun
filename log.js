/**
 * Read the user-turn prompts out of one Session's committed log.
 *
 * The log is the only source of truth for what the model saw, so the rerun
 * panel reads it directly instead of trusting any client-side cache: the
 * browser half only knows the Session id.
 *
 * Format notes (verified against dsh 0.2.1-rc.5 logs):
 * - a Session lives at `$DSH_HOME/sessions/<cwd-slug>/<sessionId>/session.v<N>.jsonl.zstd`;
 * - the file is a *sequence of concatenated zstd frames*, one or more JSONL
 *   lines each. Node's `zstdDecompressSync` stops after the first frame, and
 *   its stream form rejects the second ("Unknown frame descriptor"), so the
 *   frames are walked one by one using `info: true` → `engine.bytesWritten`;
 * - a real user prompt is a `user/message` event whose `data.source.kind` is
 *   `"user"`. Injected context (memory snapshots, agent instructions, runtime
 *   context, skill catalog, time context) is the same event type with another
 *   `source.kind`, and must not be offered as an editable prompt;
 * - `turn/end` carries the safe fork boundary: a fork cut mid-turn is balanced
 *   Host-side with synthetic closers, but a completed turn's end is the
 *   boundary the shipped branch button uses too.
 *
 * @module dsh-edit-rerun/log
 */

import { readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

/** Harness home, mirroring the launcher's own default. */
function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

/** Session ids are `session-<uuid>`; accept a bare id and normalize it. */
export function normalizeSessionId(value) {
  if (typeof value !== 'string') throw new Error('sessionId must be a string')
  const trimmed = value.trim()
  if (/^session-[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return `session-${trimmed}`
  throw new Error('invalid session id')
}

/**
 * Concatenate every zstd frame of a session log into one string.
 * A partially written trailing frame (the Session is live) is ignored.
 *
 * @param buffer - raw log bytes.
 * @returns the decoded JSONL text.
 */
export function decodeLogFrames(buffer) {
  let offset = 0
  let text = ''
  for (let guard = 0; guard < 100000; guard += 1) {
    if (offset >= buffer.length) break
    let result
    try {
      result = zlib.zstdDecompressSync(buffer.subarray(offset), { info: true })
    } catch {
      break
    }
    const consumed = result?.engine?.bytesWritten ?? 0
    if (consumed <= 0) break
    text += result.buffer.toString('utf8')
    offset += consumed
  }
  return text
}

/** Version number encoded in `session.v<N>.jsonl.zstd`, 0 for the unversioned name. */
function logVersionOf(name) {
  const match = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(name)
  return match === null ? -1 : Number(match[1] ?? 0)
}

/**
 * Locate one Session's newest log file by walking the workspace slug
 * directories. The Session id is the directory name, so no index is needed.
 *
 * @param sessionId - normalized Session id.
 * @returns absolute log path, or undefined when this Harness home has no such Session.
 */
export async function findSessionLog(sessionId) {
  const root = path.join(dshHome(), 'sessions')
  let slugs
  try {
    slugs = await readdir(root)
  } catch {
    return undefined
  }
  for (const slug of slugs) {
    const dir = path.join(root, slug, sessionId)
    let names
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    const logs = names
      .filter((name) => logVersionOf(name) >= 0)
      .sort((left, right) => logVersionOf(right) - logVersionOf(left))
    if (logs.length > 0) return path.join(dir, logs[0])
  }
  return undefined
}

/** Join the text blocks of a `user/message` payload, keeping block order. */
function promptTextOf(data) {
  const content = Array.isArray(data?.content) ? data.content : []
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Derive the editable turns from a decoded event list.
 *
 * Each entry carries the prompt text, its own event seq, and the inclusive
 * fork boundary to cut at: the seq of the `turn/end` that closed the turn
 * *before* it (null for the first prompt of the Session, which has nothing to
 * inherit).
 *
 * @param events - parsed session events, in log order.
 * @returns one entry per real user prompt, oldest first.
 */
export function turnsFromEvents(events) {
  const turnEnds = []
  const prompts = []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (!Number.isInteger(event.seq)) continue
    if (event.type === 'turn/end') {
      turnEnds.push(event.seq)
      continue
    }
    if (event.type !== 'user/message') continue
    const source = event.data?.source
    const kind = source !== null && typeof source === 'object' ? source.kind : undefined
    if (kind !== 'user') continue
    const text = promptTextOf(event.data)
    if (text.trim() === '') continue
    prompts.push({ seq: event.seq, text })
  }
  turnEnds.sort((left, right) => left - right)
  return prompts.map((prompt, index) => {
    let boundarySeq = null
    for (const seq of turnEnds) {
      if (seq >= prompt.seq) break
      boundarySeq = seq
    }
    return { index: index + 1, seq: prompt.seq, boundarySeq, text: prompt.text }
  })
}

/**
 * Read every editable prompt of one Session.
 *
 * @param sessionId - session identity from the composer slot.
 * @returns `{ sessionId, logPath, turns }`.
 * @throws when the Session has no log in this Harness home.
 */
export async function readTurns(sessionId) {
  const id = normalizeSessionId(sessionId)
  const logPath = await findSessionLog(id)
  if (logPath === undefined) throw new Error(`no session log for ${id}`)
  const raw = await readFile(logPath)
  const events = decodeLogFrames(raw)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((event) => event !== null)
  return { sessionId: id, logPath, turns: turnsFromEvents(events) }
}
