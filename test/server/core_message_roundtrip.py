#!/usr/bin/env python3
"""Parse length delimited messages with the Core library and write them back out."""
import struct
import sys

import RobotRaconteur.RobotRaconteurPython as RRPy

with open(sys.argv[1], "rb") as f:
    data = f.read()

pos = 0
with open(sys.argv[2], "wb") as out:
    while pos < len(data):
        n = struct.unpack_from("<I", data, pos + 4)[0]
        out.write(RRPy.MessageToBytes(RRPy.MessageFromBytes(data[pos:pos + n]), 2))
        pos += n
