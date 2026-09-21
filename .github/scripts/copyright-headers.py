# Copyright 2026 Ix Infrastructure Inc.

"""Enforce the Ix Infrastructure copyright header on every source file.

    python3 .github/scripts/copyright-headers.py           # check, exit 1 on misses
    python3 .github/scripts/copyright-headers.py --fix      # insert the missing ones

Run from the repository root. CI runs the check; contributors run --fix.

Deliberately NOT covered, because a header there is wrong rather than missing:
  * test fixtures — parser tests snapshot their output including line numbers,
    so a header shifts every symbol down a line and breaks them;
  * anything the repo marks linguist-generated in .gitattributes — regenerated
    by tooling (the header would be clobbered) or vendored from upstream, whose
    copyright is not ours to claim;
  * committed build output and dependencies (dist/, node_modules/, ...).

A file type absent from the tables below is not checked. Adding a language to
the repo means adding its comment syntax here.
"""

import os
import re
import subprocess
import sys

HEADER = "Copyright 2026 Ix Infrastructure Inc."

SLASH = {".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx", ".scala", ".sc",
         ".java", ".go", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".swift", ".kt"}
HASH = {".sh", ".bash", ".zsh", ".ps1", ".psm1", ".py", ".rb", ".pl"}
CMD = {".cmd", ".bat"}

EXCLUDE_RE = re.compile(
    r"(^|/)(node_modules|dist|build|out|target|vendor|third_party|\.yarn|coverage)(/|$)"
    r"|(^|/)(test-)?fixtures?(/|$)"
    r"|(^|/)__fixtures__(/|$)"
    r"|\.min\.(js|mjs|cjs)$"
    r"|\.d\.ts$"
)

SHEBANG_RE = re.compile(r"^#!")
CODING_RE = re.compile(r"^#.*coding[:=]")
ECHOOFF_RE = re.compile(r"^\s*@echo\s+off", re.I)


def comment(ext):
    if ext in SLASH:
        return "// " + HEADER
    if ext in HASH:
        return "# " + HEADER
    if ext in CMD:
        return "@REM " + HEADER
    return None


def tracked_files():
    out = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout
    return [p for p in out.splitlines() if p]


def linguist_generated(paths):
    """Files the repo itself declares generated. Let git do the glob matching."""
    if not paths:
        return set()
    proc = subprocess.run(["git", "check-attr", "--stdin", "linguist-generated"],
                          input="\n".join(paths), capture_output=True, text=True)
    return {line.rsplit(": linguist-generated:", 1)[0]
            for line in proc.stdout.splitlines() if line.endswith(": set")}


def insert_at(lines, ext):
    """Index the header goes at, keeping order-sensitive first lines in place."""
    if not lines:
        return 0
    if ext in CMD:
        # `@echo off` must stay first or the REM echoes to the console
        return 1 if ECHOOFF_RE.match(lines[0]) else 0
    if SHEBANG_RE.match(lines[0]):
        if ext == ".py" and len(lines) > 1 and CODING_RE.match(lines[1]):
            return 2
        return 1
    if ext == ".py" and CODING_RE.match(lines[0]):
        return 1
    return 0


def main(fix):
    files = tracked_files()
    generated = linguist_generated(files)
    missing, wrong = [], []

    for rel in files:
        ext = os.path.splitext(rel)[1]
        line = comment(ext)
        if line is None or EXCLUDE_RE.search(rel) or rel in generated:
            continue
        if not os.path.isfile(rel) or os.path.islink(rel):
            continue
        with open(rel, "r", encoding="utf-8", errors="surrogateescape", newline="") as fh:
            text = fh.read()
        if not text.strip():
            continue
        lines = text.split("\n")
        head = [candidate.rstrip("\r").rstrip() for candidate in lines[:5]]
        if line in head:
            continue
        if any("Copyright" in candidate for candidate in head):
            # A copyright line, but not ours verbatim — a stale spelling of the
            # entity, or someone else's claim. Never auto-"fixed": inserting a
            # second header would leave the file asserting two owners.
            wrong.append(rel)
            continue
        missing.append(rel)
        if fix:
            nl_crlf = "\r\n" in text.split("\n", 1)[0] + "\n"
            block = [line, ""]
            if nl_crlf:
                block = [b + "\r" for b in block]
            at = insert_at([candidate.rstrip("\r") for candidate in lines], ext)
            lines[at:at] = block
            with open(rel, "w", encoding="utf-8", errors="surrogateescape", newline="") as fh:
                fh.write("\n".join(lines))

    if not missing and not wrong:
        print(f"All source files carry the header: {HEADER}")
        return 0

    if wrong:
        print(f"{len(wrong)} source file(s) carry a copyright line that is not"
              f' exactly "{HEADER}":\n')
        for w in wrong:
            print(f"  {w}")
        print("\nFix these by hand — --fix will not touch them, because inserting a"
              "\nsecond header would leave the file naming two owners.\n")

    if missing:
        if fix:
            print(f"Added the header to {len(missing)} file(s):")
            for m in missing:
                print(f"  {m}")
        else:
            print(f"{len(missing)} source file(s) are missing the copyright header:\n")
            for m in missing:
                print(f"  {m}")
            print(f'\nEvery source file must start with "{HEADER}"'
                  " in that language's comment syntax.\nFix them all with:\n"
                  "\n    python3 .github/scripts/copyright-headers.py --fix\n")

    if fix and not wrong:
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main("--fix" in sys.argv))
