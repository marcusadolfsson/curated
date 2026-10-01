#!/usr/bin/env python3
"""ProxyCommand helper for SSH: opens a CONNECT tunnel through the runtime
egress proxy (same proxy as HTTPS_PROXY, but port 3130 for Tailscale).

Usage: tunnel-proxy.py <host> <port>   (as ssh ProxyCommand: ... %h %p)
"""
import base64
import os
import socket
import sys
import threading
from urllib.parse import urlparse


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: tunnel-proxy.py <host> <port>", file=sys.stderr)
        return 2
    host, port = sys.argv[1], int(sys.argv[2])

    proxy_raw = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy", "")
    u = urlparse(proxy_raw)
    if not u.hostname:
        print("no HTTPS_PROXY set", file=sys.stderr)
        return 2
    proxy_host, proxy_port = u.hostname, 3130  # docs: same proxy, port 3130

    auth = ""
    if u.username:
        creds = f"{u.username}:{u.password or ''}"
        auth = "Proxy-Authorization: Basic " + base64.b64encode(
            creds.encode()
        ).decode() + "\r\n"

    try:
        s = socket.create_connection((proxy_host, proxy_port), timeout=25)
    except OSError as exc:
        print(f"proxy connect failed: {exc}", file=sys.stderr)
        return 1

    s.sendall(
        f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n{auth}\r\n".encode()
    )
    resp = b""
    try:
        while b"\r\n\r\n" not in resp:
            chunk = s.recv(4096)
            if not chunk:
                print("proxy closed connection during CONNECT", file=sys.stderr)
                return 1
            resp += chunk
    except OSError as exc:
        print(f"proxy read failed: {exc}", file=sys.stderr)
        return 1
    status_line = resp.split(b"\r\n", 1)[0].decode(errors="replace")
    if " 200" not in status_line:
        print(f"proxy CONNECT failed: {status_line}", file=sys.stderr)
        return 1

    def sock_to_stdout() -> None:
        try:
            while True:
                data = s.recv(65536)
                if not data:
                    break
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
        except OSError:
            pass
        finally:
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    threading.Thread(target=sock_to_stdout, daemon=True).start()
    # NOTE: use read1(), not read(): BufferedReader.read(n) blocks until it
    # accumulates n bytes or EOF, which deadlocks the SSH handshake (neither
    # side ever sends 64KB up front). read1() returns after a single raw
    # read, i.e. whatever is available right now.
    try:
        while True:
            data = sys.stdin.buffer.read1(65536)
            if not data:
                break
            s.sendall(data)
    except OSError:
        pass
    finally:
        try:
            s.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        s.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
