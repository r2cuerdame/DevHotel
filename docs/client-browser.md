# Client Browser

An isolated Chromium an agent borrows, per Room, for web automation. It is
the browser that *visits* a site, and it is deliberately a different thing
from the Web Server Room that *hosts* one.

## Two capabilities, not one

| | Web Server Room capability | Client Browser capability |
|---|---|---|
| What it is | The application under test: its Node runtime, dependencies, services, ports and HTTPS domain, running inside the Room. | A DevHotel-owned Chromium process with a private profile that an agent drives through CDP or Playwright. |
| Lives where | Inside the Room's runtime (container or managed guest). | Beside the Room, on the Host, in the Client Browser runtime. |
| Reached by | `https://<project>-<nickname>.localhost` through the Gateway, and `run_in_room` for commands. | A per-session endpoint `http://127.0.0.1:<port>/cdp/<sessionId>/<token>`. |
| Created by | `create_room` / `acquire_room`, `start_room`. | `allocate_client_browser`. |
| Torn down by | `sleep_room`, `delete_room`. | `release_client_browser`, and automatically with the Room. |
| Shares with anything? | No: files, processes, network and services are Room-private. | No: profile, cookies, localStorage, sessionStorage, tabs and process are session-private. Never the Host's own Chrome profile. |

An agent testing a Room's site normally uses both: the Room serves the site
at its `.localhost` domain, and the Client Browser visits that domain. The
two are allocated, inspected and released independently.

## Why it exists

Playwright, agent-browser and similar tools compete for whatever browser
they find on the Host: a shared default profile, a shared debugging port, a
shared cookie jar. Two agents, or two Rooms, end up logged into each other's
sessions, opening tabs in each other's windows, or attaching to each other's
debugger. DevHotel provides the browser as a resource with the same
ownership rules as everything else it lends out.

## The flow

```
allocate_client_browser(roomId)
  -> { session, token, endpoint: { http, ws } }
connect Playwright / CDP to endpoint            (automate)
inspect_client_browser(sessionId, token)        (ownership, liveness, connection)
release_client_browser(sessionId, token)        (process + ephemeral profile gone)
```

```ts
import { chromium } from 'playwright'

const { token, endpoint, session } = await allocate_client_browser({ roomId })
const browser = await chromium.connectOverCDP(endpoint.http)
const page = await browser.contexts()[0].newPage()
await page.goto('https://my-project-dev.localhost')
// ...
await browser.close()
await release_client_browser({ sessionId: session.id, token })
```

`endpoint.http` answers `/json/version` (and the other `/json*` discovery
routes) the way a Chromium debugging port does, so `connectOverCDP`,
puppeteer's `connect({ browserURL })` and chrome-remote-interface all work
unchanged. `endpoint.ws` is the browser-level CDP WebSocket for raw clients.

## Ownership

- Each allocation returns a fresh session ID (`cbr_…`) and a secret token
  (`cbt_…`). The token is returned by `allocate` and echoed by `attach`; it
  is never listed, never stored (only its SHA-256 digest is), and never
  appears in `inspect`, in Room inspection, or in logs.
- Every operation — attach, inspect, navigate, screenshot, release, and every
  request on the endpoint — requires the exact session ID **and** token. A
  wrong token is `403 CLIENT_BROWSER_FORBIDDEN`; an unknown session is `404`.
  Two agents on one Host cannot reach each other's browser by accident: there
  is no default port, no shared profile and no listing that reveals a token.
- Sessions belong to a Room. `GET /v1/rooms/:id/browsers` and
  `GET /v1/browsers` show who holds what (session IDs, Room, PID, liveness
  timestamps) without tokens.
- The browser's own DevTools listener is bound to loopback on an OS-chosen
  port, with Chromium's origin check intact; it is not published. The
  DevHotel endpoint strips browser origins before tunnelling, so the raw port
  keeps rejecting web pages while the tunnelled agent is accepted.

## Isolation

A session is one Chromium process tree started with its own
`--user-data-dir`. Cookies, localStorage, sessionStorage, IndexedDB, cache,
service workers, tabs and windows are all inside that directory and that
process. Two sessions logged into the same site as different users stay
different users; a tab opened in one never appears in the other. The
integration test in `packages/core/src/__tests__/clientBrowser.integration.test.ts`
proves this against a real Chromium with two Rooms in parallel.

`profileMode` is `ephemeral` by default: the profile is created for the
session and deleted on release. `persistent` keeps one Room-owned profile
under `client-browsers/persistent/<roomId>` across sessions (one open session
per profile at a time); it is still never the Host's own profile.

`headless` defaults to `true`. A headed session opens a window on the Host
desktop but, like every DevHotel path, never injects Host input — see
[Host input isolation](./host-input-isolation.md).

`navigate_client_browser` accepts `http:`, `https:` and `about:blank` only;
`file:` and internal schemes are refused so an agent cannot use the browser to
read Host files.

## Lifecycle and cleanup

| Event | What happens to the Room's Client Browsers |
|---|---|
| `release_client_browser` | Tunnelled clients are dropped, the process is closed (graceful `Browser.close`, then the tree is reaped), the ephemeral profile is deleted, the row is removed. Nothing else is touched. |
| Room goes to sleep | Every session of that Room is released. A sleeping Room cannot be driving a browser. |
| Room is deleted | Every session of that Room is released, before the Room's runtime goes. |
| DevHotel shuts down | Every live session is released, bounded by the shutdown deadline. |
| DevHotel starts | Sessions on record belong to a process that is gone, and so do their agents' connections. Each is stopped — only after the process is proven to be a browser owning that session's profile — its ephemeral profile removed and its row dropped. Stray `client-browsers/cbr_*` directories with no row (a crash between mkdir and insert) are removed the same way. A process that cannot be proven ours is left alone and named in the startup log as `unverified`. |

`inspect_client_browser` reports `liveness.processAlive`,
`liveness.cdpReachable`, `liveness.browserVersion`,
`connection.activeClients` (WebSocket clients tunnelled right now) and the
open page targets, so a misbehaving automation connection can be diagnosed
before a second browser is allocated.

## Runtime neutrality

Ownership, endpoints and cleanup live in `ClientBrowserManager` and do not
care where the process runs. The process itself comes from a
`ClientBrowserRuntime` (`launch`, `probe`, `stopOrphan`). The current
implementation, `HostChromiumRuntime`, uses Google Chrome, Chromium or
Microsoft Edge found on the Host (or `DEVHOTEL_BROWSER_PATH`), which is what
the Docker-era install can offer since Room containers ship no browser. A
DevHotel-owned managed runtime can supply a runtime that launches Chromium
inside the guest and expose the same contract.

## Non-goals

- A general-purpose browsing UI for humans.
- Sharing or reading the user's normal Chrome profile.
- Orchestrating agents against each other; DevHotel only makes each borrowed
  browser exclusively its borrower's.
