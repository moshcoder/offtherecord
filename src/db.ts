/**
 * Off The Record's state: episodes, and who listened to them (for the A/B).
 *
 * A listener is a salted hash of their address and user agent, per day: enough
 * to count a play once, never enough to name anybody.
 */
import { Database } from 'bun:sqlite'

export type Status = 'calling' | 'live' | 'missed' | 'saving' | 'ready' | 'published' | 'failed'

export type Episode = {
  n: number
  title: string
  topic: string
  variant: string
  status: Status
  room: string
  recordingId: string
  audioPath: string
  audioBytes: number
  durationSecs: number | null
  notes: string
  transcript: string
  note: string
  createdAt: number
  hostJoinedAt: number | null
  endedAt: number | null
  publishedAt: number | null
  /** Who was interviewed: a row in guests, or null for Anthony (the show's default guest). */
  guestId: number | null
  /** Recovery (0.3.0): host redials and guest re-rings so far, and when each last went out. Kept here so a restart does not reset them. */
  hostRedials: number
  guestRings: number
  lastDialAt: number
  lastRingAt: number
  /** The guest's phone was rung for this episode (not a dial-in or an opened room), so a dropped guest can be rung back. */
  rang: boolean
}

export type GuestStatus = 'new' | 'booked' | 'recorded' | 'declined'

/** Someone who asked to be on the show, from /guest. Phone and email are never shown publicly. */
export type Guest = {
  id: number
  name: string
  phone: string
  email: string
  about: string
  topic: string
  link: string
  status: GuestStatus
  createdAt: number
}

export type ArmStats = { variant: string; episodes: number; avgMinutes: number | null; downloads: number; downloadsPerEpisode: number | null; listeners: number; completion: number | null }

export class Store {
  readonly db: Database
  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        n INTEGER PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        topic TEXT NOT NULL,
        variant TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'calling',
        room TEXT NOT NULL DEFAULT '',
        recording_id TEXT NOT NULL DEFAULT '',
        audio_path TEXT NOT NULL DEFAULT '',
        audio_bytes INTEGER NOT NULL DEFAULT 0,
        duration_secs INTEGER,
        notes TEXT NOT NULL DEFAULT '',
        transcript TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        host_joined_at INTEGER,
        ended_at INTEGER,
        published_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS downloads (
        n INTEGER NOT NULL,
        listener TEXT NOT NULL,
        day TEXT NOT NULL,
        source TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (n, listener, day)
      );
      CREATE TABLE IF NOT EXISTS progress (
        n INTEGER NOT NULL,
        listener TEXT NOT NULL,
        pct INTEGER NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (n, listener)
      );
      CREATE TABLE IF NOT EXISTS guests (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        about TEXT NOT NULL DEFAULT '',
        topic TEXT NOT NULL DEFAULT '',
        link TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'new',
        created_at INTEGER NOT NULL
      );
    `)
    // Added after episode 1 shipped.
    const has = (this.db.query('PRAGMA table_info(episodes)').all() as any[]).map((c) => c.name as string)
    if (!has.includes('guest_id')) this.db.exec('ALTER TABLE episodes ADD COLUMN guest_id INTEGER')
    for (const col of ['host_redials', 'guest_rings', 'last_dial_at', 'last_ring_at', 'rang']) if (!has.includes(col)) this.db.exec(`ALTER TABLE episodes ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`)
  }

  private toEpisode(r: any): Episode | null {
    return r
      ? { n: r.n, title: r.title, topic: r.topic, variant: r.variant, status: r.status, room: r.room, recordingId: r.recording_id, audioPath: r.audio_path, audioBytes: r.audio_bytes, durationSecs: r.duration_secs, notes: r.notes, transcript: r.transcript, note: r.note, createdAt: r.created_at, hostJoinedAt: r.host_joined_at, endedAt: r.ended_at, publishedAt: r.published_at, guestId: r.guest_id ?? null, hostRedials: r.host_redials ?? 0, guestRings: r.guest_rings ?? 0, lastDialAt: r.last_dial_at ?? 0, lastRingAt: r.last_ring_at ?? 0, rang: !!r.rang }
      : null
  }

  addEpisode(e: { topic: string; variant: string; guestId?: number | null }, now = Date.now()): Episode {
    const row: any = this.db.query('INSERT INTO episodes (n, topic, variant, created_at, guest_id) VALUES ((SELECT COALESCE(MAX(n), 0) + 1 FROM episodes), ?, ?, ?, ?) RETURNING n').get(e.topic, e.variant, now, e.guestId ?? null)
    return this.episode(row.n)!
  }

  episode(n: number): Episode | null {
    return this.toEpisode(this.db.query('SELECT * FROM episodes WHERE n = ?').get(n))
  }

  episodes(opts: { published?: boolean } = {}): Episode[] {
    // Episode numbers are the show's canonical sequence. Publishing or
    // editing a later episode must never move it ahead of an earlier number.
    const sql = opts.published ? "SELECT * FROM episodes WHERE status = 'published' ORDER BY n DESC" : 'SELECT * FROM episodes ORDER BY n DESC'
    return (this.db.query(sql).all() as any[]).map((r) => this.toEpisode(r)!)
  }

  inStatus(...statuses: Status[]): Episode[] {
    return (this.db.query(`SELECT * FROM episodes WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY n`).all(...statuses) as any[]).map((r) => this.toEpisode(r)!)
  }

  update(n: number, patch: Partial<Omit<Episode, 'n' | 'createdAt'>>): Episode {
    const cols: Record<string, string> = { title: 'title', topic: 'topic', variant: 'variant', status: 'status', room: 'room', recordingId: 'recording_id', audioPath: 'audio_path', audioBytes: 'audio_bytes', durationSecs: 'duration_secs', notes: 'notes', transcript: 'transcript', note: 'note', hostJoinedAt: 'host_joined_at', endedAt: 'ended_at', publishedAt: 'published_at', hostRedials: 'host_redials', guestRings: 'guest_rings', lastDialAt: 'last_dial_at', lastRingAt: 'last_ring_at', rang: 'rang' }
    const keys = Object.keys(patch).filter((k) => k in cols)
    if (keys.length) this.db.query(`UPDATE episodes SET ${keys.map((k) => `${cols[k]} = ?`).join(', ')} WHERE n = ?`).run(...keys.map((k) => { const v = (patch as any)[k]; return typeof v === 'boolean' ? Number(v) : v ?? null }), n)
    return this.episode(n)!
  }

  // ---- guests ----------------------------------------------------------------------

  private toGuest(r: any): Guest | null {
    return r ? { id: r.id, name: r.name, phone: r.phone, email: r.email, about: r.about, topic: r.topic, link: r.link, status: r.status, createdAt: r.created_at } : null
  }

  /** A sign-up; the same phone signing up again updates its row instead of adding one. */
  addGuest(g: Omit<Guest, 'id' | 'status' | 'createdAt'>, now = Date.now()): Guest {
    const old: any = this.db.query("SELECT id FROM guests WHERE phone = ? AND status IN ('new', 'booked')").get(g.phone)
    if (old) {
      this.db.query('UPDATE guests SET name = ?, email = ?, about = ?, topic = ?, link = ? WHERE id = ?').run(g.name, g.email, g.about, g.topic, g.link, old.id)
      return this.guest(old.id)!
    }
    const row: any = this.db.query('INSERT INTO guests (name, phone, email, about, topic, link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id').get(g.name, g.phone, g.email, g.about, g.topic, g.link, now)
    return this.guest(row.id)!
  }

  guest(id: number): Guest | null {
    return this.toGuest(this.db.query('SELECT * FROM guests WHERE id = ?').get(id))
  }

  guests(): Guest[] {
    return (this.db.query('SELECT * FROM guests ORDER BY id DESC').all() as any[]).map((r) => this.toGuest(r)!)
  }

  setGuestStatus(id: number, status: GuestStatus): Guest | null {
    this.db.query('UPDATE guests SET status = ? WHERE id = ?').run(status, id)
    return this.guest(id)
  }

  /** Sign-ups in the last hour, for a cheap flood limit on the public form. */
  recentGuests(sinceMs: number): number {
    return (this.db.query('SELECT COUNT(*) AS c FROM guests WHERE created_at >= ?').get(sinceMs) as any).c
  }

  /** One download per listener per episode per day; true when it was new. */
  addDownload(n: number, listener: string, source: 'feed' | 'web', now = Date.now()): boolean {
    const day = new Date(now).toISOString().slice(0, 10)
    return this.db.query('INSERT OR IGNORE INTO downloads (n, listener, day, source, at) VALUES (?, ?, ?, ?, ?)').run(n, listener, day, source, now).changes > 0
  }

  /** How far a listener got in the web player; only ever moves forward. */
  addProgress(n: number, listener: string, pct: number, now = Date.now()): void {
    const p = Math.max(0, Math.min(100, Math.round(pct)))
    this.db.query('INSERT INTO progress (n, listener, pct, at) VALUES (?, ?, ?, ?) ON CONFLICT (n, listener) DO UPDATE SET pct = MAX(pct, excluded.pct), at = excluded.at').run(n, listener, p, now)
  }

  downloadsOf(n: number): number {
    return (this.db.query('SELECT COUNT(*) AS c FROM downloads WHERE n = ?').get(n) as any).c
  }

  /**
   * Per format: published episodes, their length, downloads in each episode's
   * first `windowDays` (so an old episode does not win on age), and how far web
   * listeners got on average.
   */
  armStats(windowDays = 7): ArmStats[] {
    const rows = this.db
      .query(
        `SELECT e.variant AS variant,
                COUNT(*) AS episodes,
                AVG(e.duration_secs) / 60.0 AS avg_minutes,
                COALESCE(SUM((SELECT COUNT(*) FROM downloads d WHERE d.n = e.n AND d.at <= e.published_at + ?)), 0) AS downloads,
                COALESCE(SUM((SELECT COUNT(*) FROM progress p WHERE p.n = e.n)), 0) AS listeners,
                (SELECT AVG(p.pct) FROM progress p JOIN episodes e2 ON e2.n = p.n WHERE e2.variant = e.variant AND e2.status = 'published') AS completion
         FROM episodes e WHERE e.status = 'published' GROUP BY e.variant ORDER BY e.variant`,
      )
      .all(windowDays * 86400_000) as any[]
    return rows.map((r) => ({
      variant: r.variant,
      episodes: r.episodes,
      avgMinutes: r.avg_minutes === null ? null : Math.round(r.avg_minutes),
      downloads: r.downloads,
      downloadsPerEpisode: r.episodes ? Math.round((r.downloads / r.episodes) * 10) / 10 : null,
      listeners: r.listeners,
      completion: r.completion === null ? null : Math.round(r.completion),
    }))
  }
}
