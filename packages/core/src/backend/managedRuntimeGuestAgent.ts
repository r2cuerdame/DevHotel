/**
 * The guest half of the Room command channel, as it is written into the apkovl.
 *
 * It is Python rather than shell because the protocol is length-prefixed binary
 * with interleaved streams (see `managedRuntimeGuestProtocol.ts`), and busybox
 * `ash` can neither read an exact byte count nor multiplex several in-flight
 * commands. Alpine's `python3` is the smallest thing in the pinned repository
 * that can, and it is installed from the same persistent package cache the
 * container engine comes from.
 *
 * ### Why not run dockerd on a TCP socket and point a Host CLI at it
 *
 * That alternative is smaller — no agent at all — but it puts a third-party
 * client binary back inside the DevHotel install and makes the Room path depend
 * on a Docker CLI release channel again, which is the dependency #106 and #107
 * exist to remove. It also quietly changes what a Host path means: `-v
 * C:\...:/workspace` against a remote daemon resolves *inside the guest*, so
 * every Host-path call site would start succeeding against the wrong
 * filesystem instead of failing loudly. The agent keeps the engine socket
 * private to the guest and makes Host-path crossings explicit `put`/`get`.
 *
 * The agent is deliberately narrow. It runs one pinned engine executable, it
 * never evaluates a shell string, and it writes only beneath the DevHotel state
 * root, so a compromised Room cannot ask it to act outside the runtime.
 */

export const MANAGED_RUNTIME_GUEST_AGENT_PATH = '/usr/local/sbin/devhotel-room-agent'
/** Where the guest listens for the Room command channel, on the private NIC only. */
export const MANAGED_RUNTIME_AGENT_PORT = 27_017
/** The one engine executable the agent is allowed to run. */
export const MANAGED_RUNTIME_GUEST_ENGINE = '/usr/bin/docker'
/** Persistent runtime state: engine data root, package cache, Host staging area. */
export const MANAGED_RUNTIME_GUEST_STATE_ROOT = '/var/lib/devhotel'
/** Where a Host file is staged before it crosses into a Room. */
export const MANAGED_RUNTIME_GUEST_STAGE_ROOT = `${MANAGED_RUNTIME_GUEST_STATE_ROOT}/stage`

export interface ManagedRuntimeGuestAgentIdentity {
  installId: string
  runtimeId: string
}

/**
 * The agent source.
 *
 * Built from a template rather than shipped as a file so the install identity is
 * baked in: the agent refuses a `hello` whose token was not derived from this
 * install, which is what stops another process on the Host — or another DevHotel
 * install — from driving this runtime's Rooms.
 */
export function buildManagedRuntimeGuestAgent(identity: ManagedRuntimeGuestAgentIdentity): string {
  for (const value of [identity.installId, identity.runtimeId]) {
    if (!/^[0-9A-Za-z._-]{8,128}$/.test(value)) throw new Error('Managed runtime guest agent identity is invalid')
  }
  return `#!/usr/bin/env python3
# DevHotel private Room command agent. Generated; do not edit in the guest.
import os, socket, struct, subprocess, sys, threading, json, hmac, hashlib, tempfile

INSTALL_ID = ${JSON.stringify(identity.installId)}
RUNTIME_ID = ${JSON.stringify(identity.runtimeId)}
PORT = ${MANAGED_RUNTIME_AGENT_PORT}
ENGINE = ${JSON.stringify(MANAGED_RUNTIME_GUEST_ENGINE)}
STATE_ROOT = ${JSON.stringify(MANAGED_RUNTIME_GUEST_STATE_ROOT)}
STAGE_ROOT = ${JSON.stringify(MANAGED_RUNTIME_GUEST_STAGE_ROOT)}
TOKEN_FILE = os.path.join(STATE_ROOT, "boot-token")

HEADER = struct.Struct(">IBI")
MAX_PAYLOAD = ${8 * 1024 * 1024}
CHUNK = ${256 * 1024}

REQUEST, STDIN, STDIN_END, STDOUT, STDERR, RESULT, ERROR, CANCEL = range(1, 9)


def boot_token():
    """One token per boot, bound to this install, readable only by root.

    The Host learns it over the private serial line, which no Room and no other
    Host process can reach, so possession of the token is proof the caller is
    this DevHotel install rather than anything else that can open the port.
    """
    try:
        with open(TOKEN_FILE, "rb") as handle:
            existing = handle.read().strip()
            if existing:
                return existing.decode("ascii")
    except OSError:
        pass
    seed = os.urandom(32)
    token = hmac.new(seed, (INSTALL_ID + RUNTIME_ID).encode("utf-8"), hashlib.sha256).hexdigest()
    os.makedirs(STATE_ROOT, mode=0o700, exist_ok=True)
    handle = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(handle, "wb") as out:
        out.write(token.encode("ascii"))
    return token


class Connection:
    def __init__(self, sock, token):
        self.sock = sock
        self.token = token
        self.authorized = False
        self.lock = threading.Lock()
        self.stdin = {}
        self.cancelled = set()

    def send(self, kind, request_id, payload=b""):
        frame = HEADER.pack(len(payload) + 5, kind, request_id) + payload
        with self.lock:
            self.sock.sendall(frame)

    def send_json(self, kind, request_id, value):
        self.send(kind, request_id, json.dumps(value).encode("utf-8"))

    def read_exactly(self, count):
        buffer = b""
        while len(buffer) < count:
            chunk = self.sock.recv(count - len(buffer))
            if not chunk:
                return None
            buffer += chunk
        return buffer

    def serve(self):
        while True:
            header = self.read_exactly(4)
            if header is None:
                return
            declared = struct.unpack(">I", header)[0]
            if declared < 5 or declared - 5 > MAX_PAYLOAD:
                return
            rest = self.read_exactly(declared)
            if rest is None:
                return
            kind = rest[0]
            request_id = struct.unpack(">I", rest[1:5])[0]
            payload = rest[5:]
            self.handle(kind, request_id, payload)

    def handle(self, kind, request_id, payload):
        if kind == REQUEST:
            try:
                request = json.loads(payload.decode("utf-8"))
            except Exception:
                self.send_json(ERROR, request_id, {"message": "unreadable request"})
                return
            op = request.get("op")
            if op == "hello":
                # Constant-time, so a wrong token cannot be found byte by byte.
                if hmac.compare_digest(str(request.get("token", "")), self.token):
                    self.authorized = True
                    self.send_json(RESULT, request_id, {"code": 0})
                else:
                    self.send_json(ERROR, request_id, {"message": "unauthorized"})
                return
            if not self.authorized:
                self.send_json(ERROR, request_id, {"message": "unauthorized"})
                return
            if op == "exec":
                threading.Thread(target=self.exec_request, args=(request_id, request), daemon=True).start()
                return
            if op == "put":
                threading.Thread(target=self.put_request, args=(request_id, request), daemon=True).start()
                return
            if op == "get":
                threading.Thread(target=self.get_request, args=(request_id, request), daemon=True).start()
                return
            self.send_json(ERROR, request_id, {"message": "unsupported operation"})
            return
        if kind == STDIN:
            sink = self.stdin.get(request_id)
            if sink is not None:
                try:
                    sink.write(payload)
                except Exception:
                    pass
            return
        if kind == STDIN_END:
            sink = self.stdin.pop(request_id, None)
            if sink is not None:
                try:
                    sink.close()
                except Exception:
                    pass
            return
        if kind == CANCEL:
            self.cancelled.add(request_id)
            process = getattr(self, "processes", {}).get(request_id)
            if process is not None:
                try:
                    # The whole group: an engine CLI can leave a child holding
                    # the Room's streams open after the parent is gone.
                    os.killpg(os.getpgid(process.pid), 9)
                except Exception:
                    pass
            return

    def exec_request(self, request_id, request):
        argv = request.get("argv")
        if not isinstance(argv, list) or not all(isinstance(item, str) for item in argv) or not argv:
            self.send_json(ERROR, request_id, {"message": "invalid argv"})
            return
        wants_stdin = bool(request.get("stdin"))
        try:
            process = subprocess.Popen(
                [ENGINE] + argv,
                stdin=subprocess.PIPE if wants_stdin else subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
        except Exception as error:
            self.send_json(ERROR, request_id, {"message": "engine could not start: %s" % error})
            return
        if not hasattr(self, "processes"):
            self.processes = {}
        self.processes[request_id] = process
        if wants_stdin:
            self.stdin[request_id] = process.stdin

        def pump(stream, kind):
            while True:
                chunk = stream.read(CHUNK)
                if not chunk:
                    return
                self.send(kind, request_id, chunk)

        pumps = [
            threading.Thread(target=pump, args=(process.stdout, STDOUT), daemon=True),
            threading.Thread(target=pump, args=(process.stderr, STDERR), daemon=True),
        ]
        for thread in pumps:
            thread.start()
        code = process.wait()
        for thread in pumps:
            thread.join()
        self.processes.pop(request_id, None)
        self.stdin.pop(request_id, None)
        if request_id in self.cancelled:
            self.cancelled.discard(request_id)
            return
        self.send_json(RESULT, request_id, {"code": code})

    def staged_path(self, path):
        """Only beneath the staging root, and only after symlinks are resolved.

        A Room can write into paths the Host later names, so a relative segment
        or a symlink out of the staging root is refused rather than followed.
        """
        candidate = os.path.realpath(os.path.join(STAGE_ROOT, path.lstrip("/")))
        root = os.path.realpath(STAGE_ROOT)
        if candidate != root and not candidate.startswith(root + os.sep):
            raise ValueError("path escapes the DevHotel staging root")
        return candidate

    def put_request(self, request_id, request):
        try:
            target = self.staged_path(str(request.get("path", "")))
            os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
            mode = request.get("mode")
            reader, writer = os.pipe()
            self.stdin[request_id] = os.fdopen(writer, "wb")
            handle, temporary = tempfile.mkstemp(dir=os.path.dirname(target))
            with os.fdopen(handle, "wb") as out, os.fdopen(reader, "rb") as source:
                while True:
                    chunk = source.read(CHUNK)
                    if not chunk:
                        break
                    out.write(chunk)
            os.chmod(temporary, int(mode) & 0o777 if isinstance(mode, int) else 0o600)
            os.replace(temporary, target)
            self.send_json(RESULT, request_id, {"code": 0})
        except Exception as error:
            self.stdin.pop(request_id, None)
            self.send_json(ERROR, request_id, {"message": "put failed: %s" % error})

    def get_request(self, request_id, request):
        try:
            source = self.staged_path(str(request.get("path", "")))
            with open(source, "rb") as handle:
                while True:
                    chunk = handle.read(CHUNK)
                    if not chunk:
                        break
                    self.send(STDOUT, request_id, chunk)
            self.send_json(RESULT, request_id, {"code": 0})
        except Exception as error:
            self.send_json(ERROR, request_id, {"message": "get failed: %s" % error})


def main():
    token = boot_token()
    os.makedirs(STAGE_ROOT, mode=0o700, exist_ok=True)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("0.0.0.0", PORT))
    listener.listen(8)
    while True:
        client, _ = listener.accept()
        client.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        connection = Connection(client, token)

        def serve(connection=connection, client=client):
            try:
                connection.serve()
            except Exception:
                pass
            finally:
                try:
                    client.close()
                except Exception:
                    pass

        threading.Thread(target=serve, daemon=True).start()


if __name__ == "__main__":
    sys.exit(main())
`
}
