# pyimports

Fixture for the Ix real-backend harness (`ix-cli/test/e2e`). `app/main.py`
calls into `pkg/sub/mod.py` through an absolute import, an aliased module
import and a typed receiver inside a method, and into `pkg/__init__.py`
through a package import. `other/mod.py` defines the same names, so only the
import path tells the two apart.
