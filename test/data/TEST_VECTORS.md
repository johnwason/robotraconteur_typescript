# Test vectors

`test_vectors.bin` holds the numeric arrays that the client tests send and check. It is a copy of
`test/data/test_vectors.bin` from [Robot Raconteur Core](https://github.com/robotraconteur/robotraconteur), so this
implementation tests with the same data as Core and the other bindings. The format, naming convention, and the
`test_vectors_tool.py` used to inspect or extend the blob are documented in Core's
`test/data/TEST_VECTORS_FORMAT.md`.

The tests read vectors by name with `getTestVector("name", "type")` from `test/common/TestVectors.ts`. Node.js reads
this file directly, and `scripts/bundle-browser-test.mjs` embeds it in the browser test page as base64.
`scripts/port_core_client_tests.py` converts Core's `get_test_vector` calls into `getTestVector` calls.

Do not edit the copy here. To add or change vectors, change Core's blob first, then copy it over this file. CI runs
`scripts/check_test_vectors.py` to check that every vector in this copy matches Core.
