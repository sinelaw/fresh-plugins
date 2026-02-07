#!/usr/bin/env python3
"""
Amp IDE Protocol WebSocket Server for Fresh Editor.

A minimal WebSocket server using only Python stdlib that implements the
Amp IDE protocol. Communicates with the Fresh plugin via file-based IPC:

  Plugin -> Server: writes JSON lines to <ipc_dir>/cmd
  Server -> Plugin: writes JSON lines to <ipc_dir>/resp

The IPC directory is: $AMP_DATA_HOME/amp/ide/fresh-<port>/

Usage: python3 amp_server.py <auth_token> <workspace_folder>
"""

import base64
import hashlib
import json
import logging
import os
import socket
import struct
import sys
import threading
import time

WS_MAGIC = b"258EAFA5-E914-47DA-95CA-5B56DF4A2964"

clients = []
clients_lock = threading.Lock()
auth_token = ""
pending_requests = {}
request_counter = 0
request_counter_lock = threading.Lock()
ipc_dir = ""
log = logging.getLogger("amp-server")


def _get_log_path():
    cache = os.environ.get("XDG_CACHE_HOME")
    if not cache:
        cache = os.path.join(os.path.expanduser("~"), ".cache")
    log_dir = os.path.join(cache, "fresh")
    os.makedirs(log_dir, exist_ok=True)
    return os.path.join(log_dir, "amp-server.log")


def _init_logging():
    log_path = _get_log_path()
    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        handlers=[
            logging.FileHandler(log_path),
            logging.StreamHandler(sys.stderr),
        ],
    )
    log.info("Log file: %s", log_path)


def write_resp(data):
    path = os.path.join(ipc_dir, "resp")
    line = json.dumps(data) + "\n"
    try:
        with open(path, "a") as f:
            f.write(line)
    except OSError as e:
        log.error("Failed to write response: %s", e)


def ws_accept_key(key):
    return base64.b64encode(hashlib.sha1(key.encode() + WS_MAGIC).digest()).decode()


def parse_http_request(data):
    lines = data.decode("utf-8", errors="replace").split("\r\n")
    if not lines:
        return None, {}
    request_line = lines[0]
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return request_line, headers


def do_handshake(conn, auth):
    data = b""
    conn.settimeout(10)
    try:
        while b"\r\n\r\n" not in data:
            chunk = conn.recv(4096)
            if not chunk:
                log.debug("Handshake: client sent no data")
                return False
            data += chunk
    except socket.timeout:
        log.debug("Handshake: timeout waiting for request")
        return False

    request_line, headers = parse_http_request(data)
    log.debug("Handshake request: %s", request_line)
    log.debug("Handshake headers: %s", headers)

    if not request_line:
        log.debug("Handshake: no request line")
        return False

    ws_key = headers.get("sec-websocket-key")
    if not ws_key:
        log.debug("Handshake: no sec-websocket-key header")
        conn.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
        return False

    if auth:
        path = request_line.split(" ")[1] if " " in request_line else ""
        log.debug("Handshake: checking auth, path=%s", path)
        token_ok = False
        if "?" in path:
            for param in path.split("?", 1)[1].split("&"):
                if "=" in param:
                    k, v = param.split("=", 1)
                    if k == "auth" and v == auth:
                        token_ok = True
                        break
        if not token_ok:
            log.debug("Handshake: auth token mismatch")
            conn.sendall(b"HTTP/1.1 401 Unauthorized\r\n\r\n")
            return False

    accept = ws_accept_key(ws_key)
    conn.sendall((
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
    ).encode())
    return True


def recv_exact(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def read_ws_frame(conn):
    header = recv_exact(conn, 2)
    if not header:
        return None, None

    opcode = header[0] & 0x0F
    masked = header[1] & 0x80
    payload_len = header[1] & 0x7F

    if payload_len == 126:
        ext = recv_exact(conn, 2)
        if not ext:
            return None, None
        payload_len = struct.unpack("!H", ext)[0]
    elif payload_len == 127:
        ext = recv_exact(conn, 8)
        if not ext:
            return None, None
        payload_len = struct.unpack("!Q", ext)[0]

    mask_key = b""
    if masked:
        mask_key = recv_exact(conn, 4)
        if mask_key is None:
            return None, None

    payload = recv_exact(conn, payload_len)
    if payload is None:
        return None, None

    if masked and mask_key:
        payload = bytes(payload[i] ^ mask_key[i % 4] for i in range(len(payload)))

    return opcode, payload


def send_ws_frame(conn, opcode, payload):
    frame = bytes([0x80 | opcode])
    plen = len(payload)
    if plen < 126:
        frame += bytes([plen])
    elif plen < 65536:
        frame += bytes([126]) + struct.pack("!H", plen)
    else:
        frame += bytes([127]) + struct.pack("!Q", plen)
    frame += payload
    try:
        conn.sendall(frame)
    except Exception:
        pass


def send_ws_text(conn, text):
    send_ws_frame(conn, 0x1, text.encode("utf-8"))


def broadcast_notification(notification):
    msg = json.dumps({"serverNotification": notification})
    with clients_lock:
        dead = []
        for c in clients:
            try:
                send_ws_text(c, msg)
            except Exception:
                dead.append(c)
        for c in dead:
            clients.remove(c)


def send_response(conn, req_id, response):
    try:
        send_ws_text(conn, json.dumps({"serverResponse": {"id": req_id, **response}}))
    except Exception:
        pass


def send_error(conn, req_id, code, message):
    try:
        send_ws_text(conn, json.dumps({
            "serverResponse": {"id": req_id, "error": {"code": code, "message": message}}
        }))
    except Exception:
        pass


def next_request_id():
    global request_counter
    with request_counter_lock:
        request_counter += 1
        return f"fresh-{request_counter}"


def handle_client_request(conn, request):
    req_id = request.get("id")
    if not req_id:
        return

    if request.get("ping"):
        send_response(conn, req_id, {"ping": {"message": request["ping"].get("message", "")}})
        return

    if request.get("authenticate"):
        send_response(conn, req_id, {"authenticate": {"authenticated": True}})
        return

    if request.get("readFile"):
        path = request["readFile"].get("path")
        if not path:
            send_error(conn, req_id, -32602, "readFile requires path parameter")
            return
        plugin_req_id = next_request_id()
        pending_requests[plugin_req_id] = (conn, req_id, "readFile")
        write_resp({"type": "readFile", "id": plugin_req_id, "path": path})
        return

    if request.get("editFile"):
        ef = request["editFile"]
        path = ef.get("path")
        content = ef.get("fullContent")
        if not path or content is None:
            send_error(conn, req_id, -32602, "editFile requires path and fullContent")
            return
        plugin_req_id = next_request_id()
        pending_requests[plugin_req_id] = (conn, req_id, "editFile")
        write_resp({"type": "editFile", "id": plugin_req_id, "path": path, "fullContent": content})
        return

    if request.get("getDiagnostics"):
        path = request["getDiagnostics"].get("path")
        if not path:
            send_error(conn, req_id, -32602, "getDiagnostics requires path parameter")
            return
        plugin_req_id = next_request_id()
        pending_requests[plugin_req_id] = (conn, req_id, "getDiagnostics")
        write_resp({"type": "getDiagnostics", "id": plugin_req_id, "path": path})
        return

    if request.get("openURI"):
        uri = request["openURI"].get("uri")
        if not uri:
            send_error(conn, req_id, -32602, "openURI requires uri parameter")
            return
        plugin_req_id = next_request_id()
        pending_requests[plugin_req_id] = (conn, req_id, "openURI")
        write_resp({"type": "openURI", "id": plugin_req_id, "uri": uri})
        return

    send_error(conn, req_id, -32601, "Method not found")


def handle_client(conn, addr):
    log.info("Client connecting from %s", addr)

    if not do_handshake(conn, auth_token):
        log.warning("Handshake failed for %s", addr)
        conn.close()
        return

    # Reset timeout after handshake — must block indefinitely waiting for frames
    conn.settimeout(None)

    with clients_lock:
        clients.append(conn)

    log.info("Client connected: %s", addr)
    write_resp({"type": "connected"})

    try:
        while True:
            opcode, payload = read_ws_frame(conn)
            if opcode is None or payload is None:
                log.debug("Client %s: read returned None, closing", addr)
                break
            if opcode == 0x8:
                log.debug("Client %s: received close frame", addr)
                send_ws_frame(conn, 0x8, struct.pack("!H", 1000))
                break
            elif opcode == 0x9:
                log.debug("Client %s: received ping, sending pong", addr)
                send_ws_frame(conn, 0xA, payload)
            elif opcode == 0xA:
                log.debug("Client %s: received pong", addr)
                continue
            elif opcode == 0x1:
                try:
                    msg = json.loads(payload.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    log.debug("Client %s: invalid JSON frame", addr)
                    continue
                log.debug("Client %s: received message: %s", addr, list(msg.keys()))
                request = msg.get("clientRequest")
                if request:
                    handle_client_request(conn, request)
            else:
                log.debug("Client %s: unknown opcode %d", addr, opcode)
    except (ConnectionResetError, BrokenPipeError, OSError) as e:
        log.debug("Client %s: connection error: %s", addr, e)
    finally:
        with clients_lock:
            if conn in clients:
                clients.remove(conn)
        try:
            conn.close()
        except Exception:
            pass
        log.info("Client disconnected: %s", addr)
        write_resp({"type": "disconnected"})


def handle_plugin_message(line):
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        return

    msg_type = msg.get("type")

    if msg_type in ("selectionDidChange", "visibleFilesDidChange",
                     "pluginMetadata", "userSentMessage", "appendToPrompt"):
        broadcast_notification({msg_type: msg.get("data", {})})
        return

    if msg_type in ("fileResponse", "editFileResponse",
                     "diagnosticsResponse", "openURIResponse"):
        req_id = msg.get("id")
        if req_id and req_id in pending_requests:
            conn, orig_id, method = pending_requests.pop(req_id)
            data = msg.get("data", {})
            send_response(conn, orig_id, {method: data})
        return


def cmd_file_watcher():
    cmd_path = os.path.join(ipc_dir, "cmd")
    last_pos = 0

    while True:
        time.sleep(0.1)
        try:
            if not os.path.exists(cmd_path):
                continue
            with open(cmd_path, "r") as f:
                f.seek(last_pos)
                new_data = f.read()
                last_pos = f.tell()

            if not new_data:
                # Periodically reset if file was truncated
                try:
                    size = os.path.getsize(cmd_path)
                    if size < last_pos:
                        last_pos = 0
                except OSError:
                    pass
                continue

            for line in new_data.strip().split("\n"):
                if line.strip():
                    handle_plugin_message(line)
        except OSError:
            continue


def get_data_home():
    override = os.environ.get("AMP_DATA_HOME")
    if override:
        return override
    home = os.path.expanduser("~")
    if hasattr(os, "uname") and os.uname().sysname == "Linux":
        xdg = os.environ.get("XDG_DATA_HOME")
        if xdg:
            return xdg
    return os.path.join(home, ".local", "share")


def create_lockfile(port, token, workspace):
    lock_dir = os.path.join(get_data_home(), "amp", "ide")
    os.makedirs(lock_dir, exist_ok=True)
    lockfile_path = os.path.join(lock_dir, f"{port}.json")
    with open(lockfile_path, "w") as f:
        json.dump({
            "port": port,
            "authToken": token,
            "pid": os.getpid(),
            "workspaceFolders": [workspace],
            "ideName": "fresh",
        }, f)
    return lockfile_path


def remove_lockfile(port):
    try:
        os.remove(os.path.join(get_data_home(), "amp", "ide", f"{port}.json"))
    except OSError:
        pass


shutdown_event = threading.Event()


def parent_watcher(parent_pid):
    while not shutdown_event.is_set():
        time.sleep(2)
        try:
            os.kill(parent_pid, 0)
        except OSError:
            log.info("Parent process %d exited, shutting down", parent_pid)
            shutdown_event.set()
            return


def main():
    global auth_token, ipc_dir

    if len(sys.argv) < 4:
        print("Usage: amp_server.py <auth_token> <workspace_folder> <port_file>", file=sys.stderr)
        sys.exit(1)

    auth_token = sys.argv[1]
    workspace = sys.argv[2]
    port_file = sys.argv[3]

    _init_logging()
    parent_pid = os.getppid()
    log.info("Starting Amp server (pid=%d, parent=%d)", os.getpid(), parent_pid)
    log.info("Workspace: %s", workspace)

    # Exit when parent (Fresh) dies
    watcher = threading.Thread(target=parent_watcher, args=(parent_pid,), daemon=True)
    watcher.start()

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    port = server.getsockname()[1]
    server.listen(5)

    # Create IPC directory
    ipc_dir = os.path.join(get_data_home(), "amp", "ide", f"fresh-{port}")
    os.makedirs(ipc_dir, exist_ok=True)

    # Write port to the file the plugin told us to use
    with open(port_file, "w") as f:
        f.write(str(port))

    create_lockfile(port, auth_token, workspace)

    log.info("WebSocket server listening on 127.0.0.1:%d", port)
    log.info("IPC directory: %s", ipc_dir)

    # Start command file watcher thread
    watcher = threading.Thread(target=cmd_file_watcher, daemon=True)
    watcher.start()

    try:
        while not shutdown_event.is_set():
            server.settimeout(1.0)
            try:
                conn, addr = server.accept()
                t = threading.Thread(target=handle_client, args=(conn, addr), daemon=True)
                t.start()
            except socket.timeout:
                continue
    except KeyboardInterrupt:
        pass
    finally:
        remove_lockfile(port)
        # Clean up IPC directory
        try:
            for f in os.listdir(ipc_dir):
                os.remove(os.path.join(ipc_dir, f))
            os.rmdir(ipc_dir)
        except OSError:
            pass
        server.close()
        log.info("Server stopped")


if __name__ == "__main__":
    main()
