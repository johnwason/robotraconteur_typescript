#!/usr/bin/env python3
"""Run the Core Python test services using the configuration from Core's own pytest fixture."""
import os
import sys

core = os.environ["RR_CORE_TEST"]
os.environ["ROBOTRACONTEUR_ROBDEF_PATH"] = os.path.join(core, "robdef")
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(core, "python"))

from RobotRaconteurTest.service_test_util import TestServerNodeConfig  # noqa: E402

config = TestServerNodeConfig("rr_ts_test_server")
print(f"PORT {config.node_setup.tcp_transport.GetListenPort()}", flush=True)
sys.stdin.read()
config.shutdown()
