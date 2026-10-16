#!/usr/bin/env python3
"""Static retirement boundary. No legacy imports, state, tokens or request logging."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BODY = (
    "FLEXPERIMENT — LAB V1 выведен из эксплуатации.\n\n"
    "Старый сайт, личный кабинет, билеты и ссылки подтверждения больше не обслуживаются.\n"
    "По историческому заказу или возврату напишите на art@flexperiment.ru.\n"
    "Укажите номер заказа, если он есть. Не отправляйте данные карты или коды подтверждения.\n"
    "Новые продажи закрыты.\n"
).encode("utf-8")


class RetiredHandler(BaseHTTPRequestHandler):
    server_version = "Flexperiment"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, _format, *_args):
        pass

    def __getattr__(self, name):
        if name.startswith("do_"):
            return self.retired
        raise AttributeError(name)

    def retired(self):
        self.close_connection = True
        self.send_response(410, "Gone")
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(BODY)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        self.send_header("X-Robots-Tag", "noindex, nofollow, noarchive")
        self.send_header("X-Flexperiment-Retired", "LAB-V1")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(BODY)


def make_server(bind, port):
    return ThreadingHTTPServer((bind, port), RetiredHandler)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", required=True)
    parser.add_argument("--port", type=int, default=18139)
    args = parser.parse_args()
    with make_server(args.bind, args.port) as server:
        server.serve_forever()
