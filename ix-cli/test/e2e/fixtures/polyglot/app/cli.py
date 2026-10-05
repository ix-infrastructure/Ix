"""Command-line front end."""

import sys

from app.api import checkout


def main(argv=None):
    args = argv if argv is not None else sys.argv[1:]
    name = args[0] if args else "Ada Lovelace"
    print(checkout(name, "ada@example.com", [("book", 1250), ("pen", 300)]))


if __name__ == "__main__":
    main()
