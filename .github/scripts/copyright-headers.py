# Copyright 2026 Ix Infrastructure Inc.

"""Enforce the Ix Infrastructure copyright header on every source file.

    python3 .github/scripts/copyright-headers.py           # check, exit 1 on misses
    python3 .github/scripts/copyright-headers.py --fix      # insert the missing ones

On Windows, use `python` when `python3` is not on PATH.

Run from the repository root. CI runs the check; contributors run --fix.
The check's own tests are in `.github/scripts/test_copyright_headers.py`.

Deliberately NOT covered, because a header there is wrong rather than missing:
  * test fixtures — parser tests snapshot their output including line numbers,
    so a header shifts every symbol down a line and breaks them;
  * anything the repo marks linguist-generated in .gitattributes — regenerated
    by tooling (the header would be clobbered) or vendored from upstream, whose
    copyright is not ours to claim;
  * committed build output and dependencies (dist/, node_modules/, ...).

A file type absent from the tables below is not checked. Adding a language to
the repo means adding its comment syntax here.

Safety guarantees (each has a test):
  * a check run never modifies a file;
  * --fix is idempotent and preserves BOMs, CRLF line endings and bytes after
    the inserted lines;
  * a file that already names a copyright holder is reported, never given a
    second header — two notices would assert two owners;
  * a scan that finds no candidate file is an error, not a pass: a wrong
    working directory must not turn the gate green.
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
# A notice, not merely the word in prose: a comment marker followed by
# "Copyright". The covered languages all use line comments.
COPYRIGHT_RE = re.compile(r"^\s*(?://+|#+|@REM\b)\s*Copyright\b", re.I)

BOM = b"\xef\xbb\xbf"


def comment(ext):
    if ext in SLASH:
        return "// " + HEADER
    if ext in HASH:
        return "# " + HEADER
    if ext in CMD:
        return "@REM " + HEADER
    return None


def tracked_files():
    """Tracked paths, NUL-separated so spaces and unicode are preserved."""
    out = subprocess.run(["git", "ls-files", "-z"], capture_output=True, check=True).stdout
    return [p for p in out.decode("utf-8", "surrogateescape").split("\0") if p]


def linguist_generated(paths):
    """Files the repo itself declares generated. Let git do the glob matching.

    `linguist-generated` is a boolean attribute, so git reports `set` for a bare
    name and the literal value for `linguist-generated=true`.
    """
    if not paths:
        return set()
    # -z keeps every path intact. Text mode would translate "\n" to "\r\n" on
    # Windows, so Git would see a trailing CR in every path except the last and
    # silently classify those files as unspecified.
    payload = b"\0".join(p.encode("utf-8", "surrogateescape") for p in paths) + b"\0"
    proc = subprocess.run(["git", "check-attr", "-z", "--stdin", "linguist-generated"],
                          input=payload, capture_output=True)
    fields = proc.stdout.split(b"\0")
    result = set()
    for i in range(0, len(fields) - 2, 3):
        path = fields[i].decode("utf-8", "surrogateescape")
        value = fields[i + 2].decode("utf-8", "surrogateescape").strip().lower()
        if value in ("set", "true", "1", "yes"):
            result.add(path)
    return result


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
    if ext in HASH and CODING_RE.match(lines[0]):
        # A coding declaration is only honoured on line 1 or 2; it must stay.
        return 1
    return 0


def read_text(rel):
    """Return (text, had_bom) or None when the bytes are not valid UTF-8.

    Decoding with utf-8-sig removes a leading BOM from the text so line numbers
    and the first line are what a reader sees; the BOM is restored on write.
    """
    with open(rel, "rb") as fh:
        raw = fh.read()
    had_bom = raw.startswith(BOM)
    try:
        text = raw[len(BOM):].decode("utf-8") if had_bom else raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
    return text, had_bom


def write_text(rel, text, had_bom):
    data = text.encode("utf-8")
    if had_bom:
        data = BOM + data
    with open(rel, "wb") as fh:
        fh.write(data)


def scan():
    """Classify every tracked file once.

    Returns (candidates, missing, misplaced, wrong, duplicate, unreadable).
    candidates counts files the policy covers, so an empty scope is detectable.
    """
    files = tracked_files()
    generated = linguist_generated(files)
    missing, misplaced, wrong, duplicate, unreadable = [], [], [], [], []
    candidates = 0

    for rel in files:
        ext = os.path.splitext(rel)[1]
        line = comment(ext)
        if line is None or EXCLUDE_RE.search(rel) or rel in generated:
            continue
        if not os.path.isfile(rel) or os.path.islink(rel):
            continue
        decoded = read_text(rel)
        if decoded is None:
            unreadable.append(rel)
            continue
        text, _ = decoded
        if not text.strip():
            continue
        candidates += 1
        lines = [candidate.rstrip("\r") for candidate in text.split("\n")]
        head = [candidate.rstrip() for candidate in lines[:5]]
        notices = [candidate for candidate in lines if COPYRIGHT_RE.search(candidate)]
        if line in head:
            # A correct header does not excuse a second notice lower down.
            if len(notices) > 1:
                duplicate.append(rel)
            continue
        # A full-file search catches a correct header that starts too low (or a
        # copied notice) before --fix inserts a duplicate above it.
        if any(HEADER in candidate for candidate in lines):
            misplaced.append(rel)
            continue
        # Any other copyright line, anywhere in the file, is never auto-"fixed":
        # inserting a second header would leave the file asserting two owners.
        if notices:
            wrong.append(rel)
            continue
        missing.append(rel)

    return candidates, missing, misplaced, wrong, duplicate, unreadable


def insert(rel):
    decoded = read_text(rel)
    if decoded is None:
        return False
    text, had_bom = decoded
    ext = os.path.splitext(rel)[1]
    line = comment(ext)
    if line is None:
        return False
    lines = text.split("\n")
    # Detect the file's own line ending from its first line. Mixed-ending files
    # keep their existing lines untouched; only the inserted block is normalised.
    crlf = lines[0].endswith("\r") if lines else False
    block = ["\r" if crlf else "", "\r" if crlf else ""]
    at = insert_at([candidate.rstrip("\r") for candidate in lines], ext)
    lines[at:at] = [line + block[0], block[1]]
    write_text(rel, "\n".join(lines), had_bom)
    return True


def main(argv):
    fix = "--fix" in argv
    unknown = [arg for arg in argv if arg not in ("--fix",)]
    if unknown:
        print(f"unknown argument(s): {' '.join(unknown)}\n"
              "usage: copyright-headers.py [--fix]", file=sys.stderr)
        return 2

    # `git ls-files` is scoped to the current directory unless `--full-name` is
    # used. Resolve the repository root before scanning so invoking this script
    # from a nested directory cannot silently check only part of the tree. The
    # same root also anchors --fix writes to the paths returned by Git.
    try:
        root = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                              capture_output=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        print("::error::could not determine the Git repository root; run from "
              "inside a repository with Git available.", file=sys.stderr)
        return 1
    os.chdir(os.fsdecode(root.rstrip(b"\r\n")))

    candidates, missing, misplaced, wrong, duplicate, unreadable = scan()

    if candidates == 0 and not missing and not misplaced and not wrong and not duplicate and not unreadable:
        print("::error::no source files found — the scan was empty, so nothing was "
              "checked. Run from the repository root.", file=sys.stderr)
        return 1

    if not missing and not misplaced and not wrong and not duplicate and not unreadable:
        print(f"All {candidates} checked source files carry the header: {HEADER}")
        return 0

    if unreadable:
        print(f"{len(unreadable)} source file(s) are not valid UTF-8 and were not "
              "modified:\n")
        for path in unreadable:
            print(f"  {path}")
        print()

    if duplicate:
        print(f"{len(duplicate)} source file(s) contain more than one copyright"
              " notice:\n")
        for path in duplicate:
            print(f"  {path}")
        print("\nRemove the extra notice(s). --fix will not touch these files, because"
              "\nremoving or rewriting a notice needs a per-file judgement.\n")

    if wrong:
        print(f"{len(wrong)} source file(s) carry a copyright line that is not"
              f' exactly "{HEADER}" anywhere in the file:\n')
        for path in wrong:
            print(f"  {path}")
        print("\nFix these by hand — --fix will not touch them, because inserting a"
              "\nsecond header would leave the file naming two owners.\n")

    if misplaced:
        print(f"{len(misplaced)} source file(s) contain the exact header below the "
              "first five lines:\n")
        for path in misplaced:
            print(f"  {path}")
        print("\nMove the existing header to the top (after a shebang or coding"
              "\ndeclaration). --fix will not insert a second one.\n")

    if missing:
        if fix:
            added = [path for path in missing if insert(path)]
            print(f"Added the header to {len(added)} file(s):")
            for path in added:
                print(f"  {path}")
            failed = [path for path in missing if path not in added]
            if failed:
                print(f"\n{len(failed)} file(s) could not be fixed:\n")
                for path in failed:
                    print(f"  {path}")
                return 1
        else:
            print(f"{len(missing)} source file(s) are missing the copyright header:\n")
            for path in missing:
                print(f"  {path}")
            print(f'\nEvery source file must start with "{HEADER}"'
                  " in that language's comment syntax.\nFix them all with:\n"
                  "\n    python3 .github/scripts/copyright-headers.py --fix\n")

    if fix and not wrong and not misplaced and not duplicate and not unreadable:
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
