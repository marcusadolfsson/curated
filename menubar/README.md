# CuratedBar

A macOS menu bar app that says whether Curated is up, when it last synced, and
whether anyone can actually reach it. It lives in `menubar/` inside the Curated
repo on purpose: it reads Curated's own endpoints, so the two should move
together.

The icon is the whole point. It stays a plain monochrome dot while everything is
healthy, and turns orange or red the moment something needs looking at. Open it
only when it changes colour.

## Build and install

```bash
make app          # builds CuratedBar.app here
make install      # copies it to ~/Applications
make login-item   # optional: also start it at login
make uninstall    # removes both
```

Requires the Swift toolchain that ships with Xcode. There is no `.xcodeproj`:
this is a Swift package plus a short Makefile that assembles the bundle, which
keeps the whole thing editable and buildable from a terminal.

## Signing, and why it matters for autostart

The build signs with a real certificate when one is available, preferring
Developer ID and falling back to an Apple Development certificate. Override it
with `make app SIGN_ID="Developer ID Application: ..."`.

This is not ceremony. An ad-hoc signature's designated requirement is a bare
hash of the binary:

```
designated => cdhash H"f3d3e4cc2481f483cb85794ecdbfed59ce0da50a"
```

That hash changes with every rebuild, so macOS sees each build as a different
application. For something registered to start at login that is the wrong
property to have. A certificate gives a requirement built from the bundle
identifier and the certificate instead:

```
designated => identifier "com.curated.menubar" and anchor apple generic
              and certificate leaf[subject.CN] = "Apple Development: ..."
```

which is byte-for-byte identical after a rebuild. The signature is timestamped,
so it stays valid once the signing certificate eventually expires.

Autostart itself is keyed on the launch agent's path rather than the signature,
so an ad-hoc build does still start at login. What a stable identity buys is
everything macOS attaches to an app's identity rather than its location: login
item registration that is not re-evaluated on each build, and any permission
grant the app might later need. This app needs no permission grants today, which
is why an ad-hoc build works at all.

Handing the app to anyone else is a separate problem and needs Developer ID plus
notarisation.

## What it shows

**Server**, read from Curated on `127.0.0.1:3000`:

| Row | Source |
| --- | --- |
| App | whether `/api/watch` answers at all |
| Instagram | `/api/session` — signed in, or signed out and needing a cookie |
| Watcher | `/api/watch` — listening, and on how many sockets |
| Last event | `/api/watch` — when the realtime socket last stirred |
| Last sync | `/api/watch` and `/api/sync` |
| Result | `/api/sync` — what the last run concluded |
| Paused | `/api/sync` — only appears when the circuit breaker has tripped |
| Posts | `/api/posts` — unread against total |

**Access**, read from the edge:

| Row | Source |
| --- | --- |
| Public | an unauthenticated GET of the public hostname |
| Last client | derived, see below |

## Tunnel health lives elsewhere

Connector count, edge locations and connector identity are deliberately not
shown here. They belong to
[Tunnelbar](https://github.com/marcusadolfsson/tunnelbar), which watches every
connector on the machine rather than just this one, and which starts and
supervises the connector Curated is served through.

That leaves a real gap worth knowing about. The **Public** row proves DNS,
Cloudflare and Access are up, because the probe is answered at the edge. It does
**not** prove the origin is serving: if the tunnel died, that row would still say
"answering". Between them, **App** covers the origin and **Public** covers the
edge, and the tunnel in the middle is the other app's job.

## "Last client" is inferred, not reported

Nothing in the stack records when someone last opened Curated. What does exist is
cloudflared's request counter, and an unauthenticated probe of the public
hostname is answered by Cloudflare Access and never reaches the tunnel. That was
verified against this deployment: probing does not move the counter. So any
increase is a real client that got through Access, and the app treats it as a
visit. A drop means the connector restarted, and is ignored rather than counted.

This is the one place the app still reads cloudflared, and it reads exactly one
number. It does not look at connections, edges or connector identity. Without an
explicit `--metrics` flag the connector's port is random and changes on every
restart, so the port is found from the running process and re-discovered
whenever it stops answering.

Finding that process matches on the program name alone. It used to require
`tunnel run` as adjacent words, which broke silently the day Tunnelbar took the
connector over and started launching it as `cloudflared tunnel --no-autoupdate
run`, putting a flag between them. Whether a process is the right one is settled
by asking its metrics endpoint for the counter, never by guessing from an
argument order somebody else controls.

The limits are honest ones. It only notices visits while it is running, and it
cannot tell two visitors apart.

## From a terminal

The same data without a menu bar, which is useful over SSH:

```bash
CuratedBar.app/Contents/MacOS/CuratedBar --report
CuratedBar.app/Contents/MacOS/CuratedBar --json
```

Any setting can be overridden for one run with a leading dash:

```bash
CuratedBar.app/Contents/MacOS/CuratedBar --report -localBase http://127.0.0.1:3001
```

Settings are `localBase`, `publicURL`, `metricsPort` and `appAgentLabel`.
Persist one with
`defaults write com.curated.menubar publicURL https://example.com`.

`--snapshot out.png` renders the panel to a file. That is how the layout gets
checked without clicking anything.

## What it deliberately does not do

It never writes. Every route it touches is a GET, and it never sends a POST or a
DELETE to any of them, because on this app those are not idle verbs: `POST
/api/sync` starts a sync, `POST /api/watch` starts the watcher, `POST
/api/pause` pauses it, and `POST /api/session/egress` makes a real request to
Instagram to find out what address it sees.

There are no start, stop or restart controls for the launch agent either.
`com.curated.app` is supervised with `KeepAlive`, so stopping it from here would
only make it flap, and restarting it mid-sync closes a live browser session
against an account Instagram is happy to lock. Anything that changes
state belongs in a terminal, where it is deliberate.

The one request it makes off the machine is the reachability probe, once a
minute, to your own hostname. It never touches Instagram.
