# Off The Record

**How a Silicon Valley veteran programmer uses fleet engineering and agentic coding bots to build out a new internet.**

A long-form podcast: riotcoder, an AI host (an ElevenLabs agent), interviews Anthony Ettinger of Profullstack over a phone line, recorded on [group.call](https://group.call.pit.world). Listen at **https://offtherecord.podcast.pit.world** (feed: `/feed.xml`). Moshpit names: `offtherecord.podcast`, and `otr.podcast`, which redirects.

## How an episode is made

1. `otr record` makes a group.call room that records, and rings Anthony (press 1).
2. When he is on the line, the room dials the host in over SIP
   (`sip:+15106169327@sip.rtc.elevenlabs.io`), with `X-Otr-Episode`, `X-Otr-Style`,
   `X-Otr-Minutes` and `X-Otr-Topic` headers. ElevenLabs hands those to the agent as
   `{{sip_otr_*}}` dynamic variables, so one agent plays every format.
3. The host calls `check_clock` (`GET /api/host/clock`) to land on time, then `end_call`.
4. When the call ends, group.call saves the mp3. Every minute the server picks it up,
   levels it to -16 LUFS with ffmpeg, and writes a title and show notes from the
   speaker-labelled transcript (Gemini).
5. It waits as `ready` until `otr publish <n>` (set `OTR_AUTOPUBLISH=1` to skip).

## Formats (A/B)

Four formats in `src/variants.ts`: **riff** (Rogan-style hang, 60 min), **deep** (Fridman-style,
90), **sprint** (35), **marathon** (about 2 h). Two are tested at a time (`ACTIVE_ARMS`), and
the next episode takes whichever has fewer. `/stats` shows plays per episode in each
episode's first 7 days and web listen-through. After editing a format: `otr host sync`.

## CLI

```
OTR_ADMIN_KEY=... bun bin/otr record [--topic "..."] [--variant deep]
otr episodes | show <n> | publish <n> | unpublish <n> | title <n> <title> | stats | host sync
```

## Run it

Bun + Hono + bun:sqlite. Settings in `$OTR_STATE/app.env` (see `bin/install.conf`);
deploy on dev2 with `./bin/install.sh`. Port 8814.
