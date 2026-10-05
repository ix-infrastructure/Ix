# polyglot

Fixture for the Ix real-backend harness (`ix-cli/test/e2e`). A small shop in
three languages: a Python billing service (`app/`), a TypeScript cart
(`web/src/`) and a Java greeting server (`server/`). Every module calls into
at least one other file, so cross-file `CALLS` and `IMPORTS` edges exist in
each language.

See [the web cart](web/src/cart.ts) and [the billing service](app/services.py).
