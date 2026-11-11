# Test vectors

`test_vectors.bin` holds the numeric arrays that the client tests send and check. It is a copy of
`test/data/test_vectors.bin` from [Robot Raconteur Core](https://github.com/robotraconteur/robotraconteur), so this
implementation tests with the same data as Core and the other bindings. The format, naming convention, and the
`test_vectors_tool.py` used to inspect or extend the blob are documented in Core's
`test/data/TEST_VECTORS_FORMAT.md`.

The tests read vectors by name with `getTestVector("name", "type")` from `test/common/TestVectors.ts`. Node.js reads
this file directly, and `scripts/bundle-browser-test.mjs` embeds it in the browser test page as base64.
`scripts/port_core_client_tests.py` converts Core's `get_test_vector` calls into `getTestVector` calls.

Do not edit the copy here. To add or change vectors, change Core's blob first, then copy it over this file.

The copy comes from Core commit `7cd1610c519613f241b25453754fb118b270cdaf`, the merge of
robotraconteur/robotraconteur#489. CI runs `scripts/check_test_vectors.py` to check that every vector in this copy
matches the blob at that commit, which `RR_CORE_TEST_VECTORS_REF` in `.github/workflows/main.yml` names. The check
is pinned rather than following Core `master`, so that a change in Core cannot fail this repository's CI by itself.

The tests run against the Core Python test service installed from `RR_CORE_VERSION`, and that service sends and
checks its own copy of the same values. When refreshing the copy here, use a Core commit whose test vectors agree
with that release, and update `RR_CORE_TEST_VECTORS_REF` in the same change. If a vector changes in Core, update
`RR_CORE_VERSION` to a release that has the new values at the same time.
