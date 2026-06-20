#!/usr/bin/env python3
"""
Servidor local para o Bendito Field (estático, single-thread — SEM headers
COOP/COEP, igual ao GitHub Pages).

NÃO reativar COOP/COEP: o cross-origin isolation (necessário p/ o core
multithread) TRAVA o carregamento do core no Chrome — funciona no Firefox, mas
no Chrome o motor fica preso em "recriando motor". O alvo é o Chrome, então o
app roda single-thread sem esses headers. Ver memória [[chrome-mjpeg-fix]].

Uso:  python3 serve.py        (porta 8765)
      python3 serve.py 9000   (outra porta)
"""
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Sem cache: garante que você sempre pega a versão mais nova ao recarregar.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass  # silencioso


if __name__ == "__main__":
    print(f"Bendito Field em http://localhost:{PORT}  (single-thread, Chrome-first)")
    try:
        HTTPServer(("", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
