import http.server
import socketserver
import socket

PORT = 8000

def get_ip_address():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # IPを取得するための接続テスト
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip

class MyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 開発中のキャッシュによる問題を防ぐためキャッシュ無効化ヘッダーを付与
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

Handler = MyHTTPRequestHandler


class DualStackServer(socketserver.TCPServer):
    # IPv6 で待ち受けつつ IPv4 も受ける（localhost=::1 でも 127.0.0.1 でも繋がる）
    allow_reuse_address = True
    address_family = socket.AF_INET6

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except (AttributeError, OSError):
            pass
        super().server_bind()


with DualStackServer(("", PORT), Handler) as httpd:
    ip_addr = get_ip_address()
    print("--- Local Development Server ---")
    print(f"PC Local Access: http://localhost:{PORT}")
    print(f"iPad/LAN Access: http://{ip_addr}:{PORT}")
    print("--------------------------------")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
