/**
 * Off The Record's web server: the show's pages, the podcast feed and audio, the
 * host agent's clock, and an admin API that starts and publishes episodes.
 *
 * The show lives at https://offtherecord.podcast.pit.world, the pit.world relay
 * of the Moshpit name offtherecord.podcast. otr.podcast is the short name and
 * redirects here.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { Store } from './db.js'
import { episodePage, feedXml, guestPage, guestThanksPage, homePage, SITE, statsPage, type GuestForm } from './html.js'
import { startPitFooterRefresh } from './pit-footer.js'
import { RING_PLACEHOLDER, ringBar, startRingRefresh, visitorOnMoshpit } from './ring.js'
import { ringDescriptor, startRingFooterRefresh } from './ring-footer.js'
import { Show, ShowError, type Config } from './show.js'
import { VERSION } from './version.js'

export { VERSION }

const SELF = 'offtherecord.podcast'
/** Names that only ever redirect to the show. */
const SHORT_NAMES = ['otr.podcast', 'otr.podcast.pit.world']

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' https://built.indie.pit.world https://pwamart.com; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
}

type Env = { Bindings: { ip?: string } }

const same = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * A phone number as E.164, or null. Ten digits are taken as US/Canada; anything
 * else needs its country code.
 */
export function normalizePhone(raw: string): string | null {
  const plus = raw.trim().startsWith('+')
  const digits = raw.replace(/\D/g, '')
  if (!plus && digits.length === 10) return `+1${digits}`
  if (!plus && digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (plus && digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0')) return `+${digits}`
  return null
}

/** Sign-ups accepted per hour, all guests together: a cap on a flood, not on people. */
const GUESTS_PER_HOUR = 30

export function createApp(deps: { store: Store; config: Config; adminKey: string; salt: string }) {
  const { store, config } = deps
  const show = new Show(store, config)
  const app = new Hono<Env>()

  /** A listener, for counting: a salted daily hash, never stored raw. */
  const listener = (c: Context<Env>) =>
    createHash('sha256')
      .update(`${deps.salt}|${new Date().toISOString().slice(0, 10)}|${c.env?.ip ?? ''}|${c.req.header('user-agent') ?? ''}`)
      .digest('hex')
      .slice(0, 24)

  const html = (c: Context, body: string, status = 200) => {
    const direct = visitorOnMoshpit(SELF, c.req.header('host'), c.req.header('x-moshpit-name'))
    return c.html(body.replace(RING_PLACEHOLDER, ringBar(SELF, direct)), status as 200)
  }

  app.use('*', async (c, next) => {
    const host = (c.req.header('x-forwarded-host') ?? c.req.header('host') ?? '').toLowerCase().replace(/:\d+$/, '')
    if (SHORT_NAMES.includes(host)) return c.redirect(`${SITE}${c.req.path === '/' ? '/' : c.req.path}`, 301)
    await next()
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v)
  })

  app.get('/health', (c) => c.json({ ok: true, version: VERSION }))
  app.get('/.well-known/openwebring.json', (c) => c.json(ringDescriptor(), 200, { 'access-control-allow-origin': '*' }))
  app.get('/robots.txt', (c) => c.text(`User-agent: *\nDisallow: /api/\nSitemap: ${SITE}/sitemap.xml\n`))
  app.get('/sitemap.xml', (c) =>
    c.body(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/guest', '/stats', ...store.episodes({ published: true }).map((e) => `/e/${e.n}`)].map((p) => `<url><loc>${SITE}${p}</loc></url>`).join('')}</urlset>`,
      200,
      { 'content-type': 'application/xml' },
    ),
  )
  app.get('/:file{cover(-300)?\\.jpg}', (c) => new Response(Bun.file(new URL(`../public/${c.req.param('file')}`, import.meta.url).pathname), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' } }))

  app.get('/guest', (c) => html(c, guestPage()))
  app.post('/guest', async (c) => {
    const b = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
    const field = (k: string, max: number) => String(b[k] ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
    const form: GuestForm = { name: field('name', 80), phone: field('phone', 24), email: field('email', 120), about: field('about', 600), topic: field('topic', 180), link: field('link', 200) }
    // A filled honeypot is a bot: thank it and keep nothing.
    if (field('website', 200)) return html(c, guestThanksPage(form.name || 'friend'))
    const phone = normalizePhone(form.phone ?? '')
    const error = !form.name
      ? 'Tell us your name.'
      : !phone
        ? 'That phone number does not look right. Use the full number, with the country code outside the US.'
        : !form.about
          ? 'Tell the host who you are and what you build.'
          : form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)
            ? 'That email does not look right (it is optional).'
            : form.link && !/^https?:\/\//i.test(form.link)
              ? 'The link should start with https://.'
              : b.consent !== '1'
                ? 'Tick the box to agree to the call being recorded and published.'
                : null
    if (error) return html(c, guestPage({ error, form }), 400)
    if (store.recentGuests(Date.now() - 3600_000) >= GUESTS_PER_HOUR) return html(c, guestPage({ error: 'Lots of sign-ups right now. Try again in an hour.', form }), 429)
    const g = store.addGuest({ name: form.name!, phone: phone!, email: form.email ?? '', about: form.about!, topic: form.topic ?? '', link: form.link ?? '' })
    console.log(`otr: guest sign-up #${g.id}: ${g.name}`)
    return html(c, guestThanksPage(g.name))
  })

  app.get('/', (c) => html(c, homePage(store.episodes({ published: true }).map((e) => ({ e, downloads: store.downloadsOf(e.n) })))))
  app.get('/stats', (c) => html(c, statsPage(store.armStats())))
  app.get('/e/:n{[0-9]+}', (c) => {
    const e = store.episode(Number(c.req.param('n')))
    if (!e || e.status !== 'published') return c.text('No such episode.', 404)
    return html(c, episodePage(e, store.downloadsOf(e.n)))
  })
  app.get('/e/:n{[0-9]+}/transcript.txt', (c) => {
    const e = store.episode(Number(c.req.param('n')))
    return e && e.status === 'published' ? c.text(e.transcript || '(no transcript)') : c.text('No such episode.', 404)
  })
  app.get('/feed.xml', (c) => c.body(feedXml(store.episodes({ published: true })), 200, { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=300' }))

  /**
   * The audio, with byte ranges (players seek, and Apple requires it). A request
   * from the start counts as a play, once per listener per day.
   */
  app.get('/audio/:file{[0-9]+\\.mp3}', async (c) => {
    const n = Number(c.req.param('file').replace(/\.mp3$/, ''))
    const e = store.episode(n)
    if (!e || e.status !== 'published' || !e.audioPath) return c.text('No such episode.', 404)
    const file = Bun.file(e.audioPath)
    const size = file.size
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '')
    const base = { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=86400' }
    let start = 0
    let end = size - 1
    if (range) {
      if (range[1] === '' && range[2] !== '') start = Math.max(0, size - Number(range[2]))
      else {
        start = Number(range[1] || 0)
        if (range[2] !== '') end = Math.min(size - 1, Number(range[2]))
      }
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${size}` } })
    }
    if (start === 0 && c.req.method === 'GET') {
      const ua = (c.req.header('user-agent') ?? '').toLowerCase()
      store.addDownload(n, listener(c), c.req.header('sec-fetch-dest') === 'audio' || ua.includes('mozilla') ? 'web' : 'feed')
    }
    if (!range) return new Response(file, { headers: { ...base, 'content-length': String(size) } })
    return new Response(file.slice(start, end + 1), { status: 206, headers: { ...base, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } })
  })

  /** The web player's listen-through beacon (25/50/75/100%). */
  app.post('/api/listen', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { n?: unknown; pct?: unknown }
    const n = Number(b.n)
    const e = Number.isInteger(n) ? store.episode(n) : null
    if (e?.status === 'published' && Number.isFinite(Number(b.pct))) store.addProgress(n, listener(c), Number(b.pct))
    return c.body(null, 204)
  })

  // ---- the host's tool ---------------------------------------------------------------

  app.get('/api/host/clock', (c) => {
    if (!same(c.req.header('x-otr-secret') ?? '', config.hostToolSecret)) return c.json({ error: 'forbidden' }, 403)
    return c.json(show.clock(Number(c.req.query('episode'))))
  })

  // ---- admin ----------------------------------------------------------------------------

  const admin = (handler: (c: Context<Env>) => Promise<Response> | Response) => async (c: Context<Env>) => {
    const key = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!deps.adminKey || !same(key, deps.adminKey)) return c.json({ error: 'unauthorized' }, 401)
    try {
      return await handler(c)
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, (e instanceof ShowError ? e.status : 500) as 400)
    }
  }
  const json = (e: ReturnType<Store['episode']>) =>
    e && { n: e.n, title: e.title, topic: e.topic, variant: e.variant, guest: e.guestId, status: e.status, room: e.room, duration_secs: e.durationSecs, note: e.note || undefined, created_at: new Date(e.createdAt).toISOString(), published_at: e.publishedAt ? new Date(e.publishedAt).toISOString() : null, page: `${SITE}/e/${e.n}`, preview: e.audioPath ? `${SITE}/api/v1/episodes/${e.n}/audio.mp3` : null }

  app.get('/api/v1/episodes', admin((c) => c.json({ episodes: store.episodes().map(json) })))
  app.post(
    '/api/v1/episodes',
    admin(async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { topic?: string; variant?: string; guest?: number }
      return c.json(json(await show.start({ ...(b.topic ? { topic: String(b.topic) } : {}), ...(b.variant ? { variant: String(b.variant) } : {}), ...(b.guest ? { guest: Number(b.guest) } : {}) })), 202)
    }),
  )
  app.get('/api/v1/episodes/:n{[0-9]+}', admin((c) => c.json({ ...json(store.episode(Number(c.req.param('n')))), notes: store.episode(Number(c.req.param('n')))?.notes })))
  app.post('/api/v1/episodes/:n{[0-9]+}/publish', admin((c) => c.json(json(show.publish(Number(c.req.param('n')))))))
  app.post('/api/v1/episodes/:n{[0-9]+}/unpublish', admin((c) => c.json(json(show.unpublish(Number(c.req.param('n')))))))
  app.patch(
    '/api/v1/episodes/:n{[0-9]+}',
    admin(async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { title?: string; notes?: string }
      const n = Number(c.req.param('n'))
      if (!store.episode(n)) throw new ShowError('No such episode.', 404)
      return c.json(json(store.update(n, { ...(b.title ? { title: String(b.title).slice(0, 100) } : {}), ...(b.notes ? { notes: String(b.notes).slice(0, 5000) } : {}) })))
    }),
  )
  /** Listen before publishing. */
  app.get(
    '/api/v1/episodes/:n{[0-9]+}/audio.mp3',
    admin((c) => {
      const e = store.episode(Number(c.req.param('n')))
      return e?.audioPath ? new Response(Bun.file(e.audioPath), { headers: { 'content-type': 'audio/mpeg' } }) : c.json({ error: 'no audio yet' }, 404)
    }),
  )
  const guestJson = (g: ReturnType<Store['guest']>) => g && { id: g.id, name: g.name, phone: g.phone, email: g.email || undefined, about: g.about, topic: g.topic || undefined, link: g.link || undefined, status: g.status, created_at: new Date(g.createdAt).toISOString() }
  app.get('/api/v1/guests', admin((c) => c.json({ guests: store.guests().map(guestJson) })))
  app.post(
    '/api/v1/guests/:id{[0-9]+}/status',
    admin(async (c) => {
      const { status } = (await c.req.json().catch(() => ({}))) as { status?: string }
      if (!['new', 'booked', 'recorded', 'declined'].includes(String(status))) throw new ShowError('status is new, booked, recorded or declined.')
      const g = store.setGuestStatus(Number(c.req.param('id')), status as 'new')
      if (!g) throw new ShowError('No such guest.', 404)
      return c.json(guestJson(g))
    }),
  )
  app.post('/api/v1/host/sync', admin(async (c) => c.json(await show.syncHost())))
  app.get('/api/v1/stats', admin((c) => c.json({ arms: store.armStats() })))

  return { app, show }
}

export function serve() {
  const env = process.env
  const state = env.OTR_STATE ?? `${env.HOME}/.local/share/offtherecord`
  const need = (name: string) => {
    if (!env[name]) throw new Error(`${name} must be set`)
    return env[name]!
  }
  const store = new Store(env.OTR_DB ?? `${state}/offtherecord.db`)
  const ffmpeg = Bun.which('ffmpeg')
  const { app, show } = createApp({
    store,
    adminKey: need('OTR_ADMIN_KEY'),
    salt: need('OTR_SALT'),
    config: {
      origin: env.OTR_ORIGIN ?? SITE,
      audioDir: `${state}/audio`,
      groupcallUrl: env.GROUPCALL_URL ?? 'https://group.call.pit.world',
      groupcallKey: need('GROUPCALL_KEY'),
      guestPhone: need('OTR_GUEST_PHONE'),
      guestName: env.OTR_GUEST_NAME ?? 'Anthony',
      hostSip: need('OTR_HOST_SIP'),
      hostToolSecret: need('OTR_HOST_TOOL_SECRET'),
      ...(env.ELEVENLABS_API_KEY ? { elevenlabsKey: env.ELEVENLABS_API_KEY } : {}),
      ...(env.OTR_AGENT_ID ? { agentId: env.OTR_AGENT_ID } : {}),
      ...(env.GEMINI_API_KEY ? { geminiKey: env.GEMINI_API_KEY } : {}),
      autopublish: env.OTR_AUTOPUBLISH !== '0',
      ffmpeg,
    },
  })
  // Finished recordings are picked up every minute; a restart mid-call loses nothing.
  setInterval(() => void show.tick(), 60_000)
  startRingRefresh()
  startPitFooterRefresh(SELF)
  startRingFooterRefresh()
  const trustProxy = (env.OTR_TRUST_PROXY ?? '1') === '1'
  return Bun.serve({
    port: Number(env.PORT ?? 8814),
    hostname: env.HOST ?? '127.0.0.1',
    fetch(request, srv) {
      const peer = srv.requestIP(request)?.address ?? ''
      const forwarded = trustProxy && (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1') ? request.headers.get('x-real-ip') : null
      return app.fetch(request, { ip: forwarded || peer })
    },
  })
}

if (import.meta.main) {
  const server = serve()
  console.log(`offtherecord listening on http://${server.hostname}:${server.port}`)
}
