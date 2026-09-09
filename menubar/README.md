# Curated

The Curated app. It carries the server, starts it, supervises it, and says in
the menu bar whether it is up, when it last synced and whether anyone can reach
it. It lives in `menubar/` inside the Curated repo because it ships the server
built from it, so the two have to move together.

Built with `make install` instead, it is only the menu bar half, watching a
server somebody else runs - which is the fast loop when the menu is what you
are changing.

The icon is the whole point. It stays a plain monochrome dot while everything is
healthy, and turns orange or red the moment something needs looking at. Open it
only when it changes colour.

## Build and install

```bash
make app                  # builds Curated.app here, without the server
make install-standalone   # the whole thing: menu bar app, Node, server
make install              # just the menu bar app, for working on it
make uninstall            # removes it
```

Requires the Swift toolchain that ships with Xcode. There is no `.xcodeproj`:
this is a Swift package plus a short Makefile that assembles the bundle, which
keeps the whole thing editable and buildable from a terminal.

**Installing does not replace what is already running.** `open` on an app that
is running activates it rather than launching the new copy, so the new binary
sits in `~/Applications` while the old one carries on and the change appears to
have done nothing. Quit it first:

```bash
pkill -f "Curated.app/Contents/MacOS/Curated"
```

The server is a child process and stops with it, so this is also how to restart
the whole thing.

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
designated => identifier "com.curated.app" and anchor apple generic
              and certificate leaf[subject.CN] = "Apple Development: ..."
```

which is byte-for-byte identical after a rebuild. The signature is timestamped,
so it stays valid once the signing certificate eventually expires.

Autostart depends on this directly now. The login item is registered by the app
itself through `SMAppService`, and macOS tracks it by bundle identity rather
than by a path in a plist - so an identity that changes on every build is an
app macOS keeps having to be introduced to. It is also what makes moving or
renaming the bundle harmless, and what puts a single entry in System Settings
rather than one per build.

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
Curated.app/Contents/MacOS/Curated --report
Curated.app/Contents/MacOS/Curated --json
```

Any setting can be overridden for one run with a leading dash:

```bash
Curated.app/Contents/MacOS/Curated --report -localBase http://127.0.0.1:3001
```

Settings are `localBase`, `publicURL` and `metricsPort`. Persist one with
`defaults write com.curated.app publicURL https://example.com`.

`--start-at-login` and `--no-start-at-login` register or remove the login item
without opening the menu.

`--snapshot out.png` renders the panel to a file. That is how the layout gets
checked without clicking anything.

## What it deliberately does not do

Almost every route it touches is a GET, and the writes are counted on one hand:
signing in, signing out, setting the Claude credential. Those earn it by being
what you reach for when the app has stopped doing its job, which is when the
menu bar is where you are looking. Each one asks first, because a menu is easy
to hit by accident.

Everything else stays a read. It does not start a sync, start or stop the
watcher, or pause anything, because on this app those are not idle verbs - and
restarting mid-sync closes a live browser session against an account Instagram
is happy to lock. Those belong in a terminal, where they are deliberate.

The one request it makes off the machine is the reachability probe, once a
minute, to your own hostname. It never touches Instagram.
