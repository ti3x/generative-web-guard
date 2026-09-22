# Phase 7 regression fixtures

Each finding records its original seed or manual origin, minimized input/trace,
and a named regression at the affected boundary. Campaign reports are ignored
under phase7-output; these fixtures are reviewable permanent evidence.

`manual-ack-identity`: discovered by a manual probe during planning; regression
in frame-channel.test.js. Sequence 1, request 7, generation 3 must ignore
acknowledgements for request 8 or generation 4, then accept the matching ack.
