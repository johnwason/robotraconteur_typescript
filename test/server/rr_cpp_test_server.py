#!/usr/bin/env python3
"""Run the Core C++ test server and report its port the same way as rr_test_server.py."""
import os
import signal
import subprocess
import sys

PORT = 22222  # Fixed by test_server.cpp

server = subprocess.Popen([os.environ["RR_CPP_TEST_SERVER"]], stdin=sys.stdin, stdout=subprocess.PIPE, text=True)
signal.signal(signal.SIGTERM, lambda *_: (server.terminate(), sys.exit(0)))

for line in server.stdout:
    print(line, end="", file=sys.stderr, flush=True)
    if "Server started" in line:
        print(f"PORT {PORT}", flush=True)

sys.exit(server.wait())
