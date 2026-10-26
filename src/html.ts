/**
 * Off The Record's pages and podcast feed. Server-rendered, no framework; the
 * only script is the player's listen-through beacon.
 */
import type { ArmStats, Episode } from './db.js'
import { pitFooter } from './pit-footer.js'
import { RING_PLACEHOLDER } from './ring.js'
import { ringFooter } from './ring-footer.js'
import { ACTIVE_ARMS, VARIANTS, variant } from './variants.js'

export const SITE = 'https://offtherecord.podcast.pit.world'
export const SHOW = 'Off The Record'
export const TAGLINE = 'How a Silicon Valley veteran programmer uses fleet engineering and agentic coding bots to build out a new internet.'
export const AUTHOR = 'Anthony Ettinger'
export const OWNER_EMAIL = 'riotcoder@profullstack.com'

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export const minutes = (secs: number | null) => (secs === null ? '' : secs >= 3600 ? `${Math.floor(secs / 3600)} h ${Math.round((secs % 3600) / 60)} min` : `${Math.round(secs / 60)} min`)
const hms = (secs: number) => [Math.floor(secs / 3600), Math.floor((secs % 3600) / 60), secs % 60].map((x) => String(x).padStart(2, '0')).join(':')
const day = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : '')

const STYLE = `
:root{--bg:#0b0b0d;--fg:#ecebe6;--muted:#9a978e;--line:#26252a;--accent:#ff4d2e;--card:#141317}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--bg:#f6f4ee;--fg:#141317;--muted:#5d5a52;--line:#ddd8cc;--card:#fff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}
a{color:inherit;text-decoration-color:var(--accent);text-underline-offset:3px}
header.top{max-width:760px;margin:0 auto;padding:18px 16px 0;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.brand{font-weight:800;letter-spacing:.02em;text-decoration:none;text-transform:uppercase}
.brand b{color:var(--accent)}
nav a{margin-left:14px;color:var(--muted)}
h1{font-size:clamp(2rem,6vw,3.2rem);line-height:1.05;margin:.4em 0 .2em;letter-spacing:-.02em}
h2{font-size:1.25rem;margin:2em 0 .6em}
.lede{font-size:1.15rem;color:var(--muted);max-width:40em}
.cover{width:132px;height:132px;border-radius:14px;float:right;margin:0 0 12px 16px}
.subscribe{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}
.btn{display:inline-block;padding:8px 14px;border:1px solid var(--line);border-radius:999px;text-decoration:none;background:var(--card)}
.ep{border-top:1px solid var(--line);padding:18px 0}
.ep h3{margin:0 0 4px;font-size:1.15rem}
.meta{color:var(--muted);font-size:.9rem}
.tag{display:inline-block;font-size:.75rem;padding:1px 8px;border-radius:999px;border:1px solid var(--line);margin-right:6px}
audio{width:100%;margin:10px 0 0}
.notes p{margin:.6em 0}
pre.transcript{white-space:pre-wrap;font:14px/1.55 ui-monospace,monospace;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;max-height:60vh;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:.95rem}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}
.muted{color:var(--muted)}
.btn.go{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:700}
form.guest{display:grid;gap:14px;margin:20px 0}
form.guest label{display:grid;gap:4px;font-weight:600}
form.guest label span{font-weight:400;color:var(--muted);font-size:.9rem}
form.guest input,form.guest textarea{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;width:100%}
form.guest label.check{display:flex;gap:10px;align-items:flex-start;font-weight:400}
form.guest label.check input{width:auto;margin-top:6px}
form.guest button{font:inherit;justify-self:start;cursor:pointer}
.hp{position:absolute;left:-9999px}
.err{border:1px solid var(--accent);border-radius:10px;padding:10px 14px}
`

const BEACON = `document.querySelectorAll('audio[data-n]').forEach(function(a){var sent=0;a.addEventListener('timeupdate',function(){if(!a.duration)return;var p=Math.floor(a.currentTime/a.duration*4)*25;if(p>sent){sent=p;navigator.sendBeacon('/api/listen',JSON.stringify({n:+a.dataset.n,pct:p}))}})})`

export function layout(o: { title: string; description: string; path: string; body: string; noindex?: boolean }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<meta name="color-scheme" content="dark light">
${o.noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(SITE + o.path)}">`}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SHOW}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:image" content="${SITE}/cover.jpg">
<link rel="alternate" type="application/rss+xml" title="${SHOW}" href="${SITE}/feed.xml">
<link rel="icon" href="/cover.jpg">
<style>${STYLE}</style>
</head>
<body>
${RING_PLACEHOLDER}
<header class="top"><a class="brand" href="/">Off <b>The</b> Record</a><nav aria-label="Site"><a href="/guest">Be a guest</a><a href="/feed.xml">RSS</a><a href="/stats">Formats</a></nav></header>
<main>
${o.body}
</main>
${ringFooter()}
${pitFooter()}
<script>${BEACON}</script>
</body>
</html>`
}

const notesHtml = (notes: string) => notes.split(/\n{2,}/).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('')

function episodeCard(e: Episode, downloads: number): string {
  const v = variant(e.variant)
  return `<article class="ep">
  <h3><a href="/e/${e.n}">#${e.n}: ${esc(e.title || e.topic)}</a></h3>
  <div class="meta"><span class="tag">${esc(v.name)}</span>${esc(day(e.publishedAt))} · ${esc(minutes(e.durationSecs))}${downloads ? ` · ${downloads} plays` : ''}</div>
  <audio controls preload="none" data-n="${e.n}" src="/audio/${e.n}.mp3"></audio>
</article>`
}

export function homePage(episodes: { e: Episode; downloads: number }[]): string {
  return layout({
    title: `${SHOW}: fleet engineering, agentic coding bots and a new internet`,
    description: TAGLINE,
    path: '/',
    body: `<img class="cover" src="/cover-300.jpg" alt="" width="132" height="132">
<h1>Off The Record</h1>
<p class="lede">${esc(TAGLINE)}</p>
<p>${esc(AUTHOR)}, founder of Profullstack, interviewed long-form by riotcoder, the AI agent that ships his code. Recorded over a phone line on <a href="https://group.call.pit.world">group.call</a>.</p>
<div class="subscribe"><a class="btn go" href="/guest">Be a guest (free)</a><a class="btn" href="/feed.xml">Podcast feed (RSS)</a><a class="btn" href="/stats">Which format wins?</a></div>
<h2>Episodes</h2>
${episodes.length ? episodes.map(({ e, downloads }) => episodeCard(e, downloads)).join('') : '<p class="muted">The first episode is being recorded. Subscribe to the feed and it shows up in your player.</p>'}`,
  })
}

export type GuestForm = { name?: string; phone?: string; email?: string; about?: string; topic?: string; link?: string }

/** The sign-up for guests: leave a phone number and the host calls you. */
export function guestPage(o: { error?: string; form?: GuestForm } = {}): string {
  const f = o.form ?? {}
  return layout({
    title: `Be a guest on ${SHOW}`,
    description: 'Come on Off The Record, free. An AI host calls your phone and interviews you, long-form, about what you are building with AI agents. Leave your number and it calls you.',
    path: '/guest',
    body: `<h1>Be a guest. It is free.</h1>
<p class="lede">Building something with AI agents, running a fleet, or working on the new internet? Come on the show. riotcoder, the AI host, calls your phone and interviews you, long-form, 35 minutes to two hours.</p>
<p>How it works: leave your number below. When your episode is booked, your phone rings from the show's line; press 1 and the host joins. No app, no link, no studio. The call is recorded and a person listens to it before it is published.</p>
${o.error ? `<p class="err" role="alert">${esc(o.error)}</p>` : ''}
<form class="guest" method="post" action="/guest">
<label>Your name<input name="name" required maxlength="80" autocomplete="name" value="${esc(f.name)}"></label>
<label>Phone number <span>The host calls this number. Include the country code outside the US.</span><input name="phone" type="tel" required maxlength="24" autocomplete="tel" placeholder="+1 408 555 0100" value="${esc(f.phone)}"></label>
<label>Email <span>Optional, so we can tell you when your episode is out.</span><input name="email" type="email" maxlength="120" autocomplete="email" value="${esc(f.email)}"></label>
<label>Who you are and what you build <span>The host reads this before the call. Two or three sentences.</span><textarea name="about" required maxlength="600" rows="4">${esc(f.about)}</textarea></label>
<label>What you want to talk about <span>Optional.</span><input name="topic" maxlength="180" value="${esc(f.topic)}"></label>
<label>A link <span>Your site, project or profile. Optional.</span><input name="link" type="url" maxlength="200" value="${esc(f.link)}"></label>
<label class="hp" aria-hidden="true">Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label>
<label class="check"><input type="checkbox" name="consent" value="1" required> I agree to be called, recorded, and to have the conversation published as a podcast episode with a transcript.</label>
<button class="btn go" type="submit">Put me on the show</button>
</form>
<p class="muted">Your phone number and email are never published or shared. Listen to an episode first: <a href="/">all episodes</a>.</p>`,
  })
}

export function guestThanksPage(name: string): string {
  return layout({
    title: `You are on the list · ${SHOW}`,
    description: 'Thanks for signing up to be a guest on Off The Record.',
    path: '/guest',
    noindex: true,
    body: `<h1>You are on the list, ${esc(name)}.</h1>
<p class="lede">When your episode is booked, your phone rings from the show's line. Press 1 and riotcoder, the AI host, joins and starts the interview.</p>
<p>Pick somewhere quiet with good signal. Until then: <a href="/">listen to an episode</a> or <a href="/feed.xml">subscribe to the feed</a>.</p>`,
  })
}

export function episodePage(e: Episode, downloads: number): string {
  const v = variant(e.variant)
  return layout({
    title: `#${e.n}: ${e.title || e.topic} · ${SHOW}`,
    description: (e.notes.split('\n')[0] || e.topic).slice(0, 300),
    path: `/e/${e.n}`,
    body: `<p class="meta"><a href="/">Off The Record</a> · episode ${e.n}</p>
<h1>${esc(e.title || e.topic)}</h1>
<div class="meta"><span class="tag">${esc(v.name)}</span>${esc(day(e.publishedAt))} · ${esc(minutes(e.durationSecs))}${downloads ? ` · ${downloads} plays` : ''}</div>
<audio controls preload="metadata" data-n="${e.n}" src="/audio/${e.n}.mp3"></audio>
<p><a href="/audio/${e.n}.mp3" download>Download the mp3</a></p>
<section class="notes">${notesHtml(e.notes)}</section>
${e.transcript ? `<h2>Transcript</h2><p class="muted">Transcribed by machine, so names and words can be wrong.</p><pre class="transcript">${esc(e.transcript)}</pre>` : ''}`,
  })
}

export function statsPage(arms: ArmStats[]): string {
  const row = (key: string) => {
    const v = variant(key)
    const s = arms.find((a) => a.variant === key)
    return `<tr><td><b>${esc(v.name)}</b>${ACTIVE_ARMS.includes(key) ? ' <span class="tag">testing now</span>' : ''}<br><span class="muted">${esc(v.blurb)}</span></td><td>${s?.episodes ?? 0}</td><td>${s?.avgMinutes ?? '-'}</td><td>${s?.downloadsPerEpisode ?? '-'}</td><td>${s?.completion !== null && s?.completion !== undefined ? `${s.completion}%` : '-'}</td></tr>`
  }
  return layout({
    title: `Which format wins? · ${SHOW}`,
    description: 'Off The Record tests its formats against each other in the open: plays per episode and how far people listen.',
    path: '/stats',
    body: `<h1>Which format wins?</h1>
<p class="lede">Every episode is recorded in one of four formats, and two are tested against each other at a time. Here is how they are doing.</p>
<table><thead><tr><th>Format</th><th>Episodes</th><th>Avg min</th><th>Plays per episode, first 7 days</th><th>Listened through (web)</th></tr></thead>
<tbody>${VARIANTS.map((v) => row(v.key)).join('')}</tbody></table>
<p class="muted">A play is one listener (feed or web) per episode per day. "Listened through" is how far web listeners got, on average. Small numbers settle nothing; this page says so by staying boring until the gap is big.</p>`,
  })
}

/** The podcast feed: RSS 2.0 with the iTunes and Podcasting 2.0 tags players read. */
export function feedXml(episodes: Episode[]): string {
  const x = (s: unknown) => esc(s)
  const items = episodes
    .map(
      (e) => `<item>
<title>${x(`#${e.n}: ${e.title || e.topic}`)}</title>
<link>${SITE}/e/${e.n}</link>
<guid isPermaLink="false">offtherecord-${e.n}</guid>
<pubDate>${new Date(e.publishedAt ?? e.createdAt).toUTCString()}</pubDate>
<description>${x(e.notes || e.topic)}</description>
<enclosure url="${SITE}/audio/${e.n}.mp3" length="${e.audioBytes}" type="audio/mpeg"/>
<itunes:episode>${e.n}</itunes:episode>
<itunes:episodeType>full</itunes:episodeType>
${e.durationSecs ? `<itunes:duration>${hms(e.durationSecs)}</itunes:duration>` : ''}
<itunes:explicit>false</itunes:explicit>
${e.transcript ? `<podcast:transcript url="${SITE}/e/${e.n}/transcript.txt" type="text/plain"/>` : ''}
</item>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${SHOW}</title>
<link>${SITE}/</link>
<atom:link href="${SITE}/feed.xml" rel="self" type="application/rss+xml"/>
<description>${x(TAGLINE)}</description>
<language>en-us</language>
<itunes:author>${x(AUTHOR)}</itunes:author>
<itunes:owner><itunes:name>${x(AUTHOR)}</itunes:name><itunes:email>${OWNER_EMAIL}</itunes:email></itunes:owner>
<itunes:image href="${SITE}/cover.jpg"/>
<image><url>${SITE}/cover.jpg</url><title>${SHOW}</title><link>${SITE}/</link></image>
<itunes:category text="Technology"/>
<itunes:explicit>false</itunes:explicit>
<itunes:type>episodic</itunes:type>
<podcast:locked>no</podcast:locked>
${items}
</channel>
</rss>`
}
