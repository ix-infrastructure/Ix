# Copyright 2026 Ix Infrastructure Inc.

"""Tests for .github/scripts/copyright-headers.py.

Run directly (stdlib only, no install):

    python3 .github/scripts/test_copyright_headers.py

Each test builds a throwaway git repository, so the suite exercises the real
`git ls-files` / `git check-attr` paths the CI job uses rather than mocks.
"""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().with_name("copyright-headers.py")
HEADER = "Copyright 2026 Ix Infrastructure Inc."
TS_HEADER = "// " + HEADER
SH_HEADER = "# " + HEADER
BOM = b"\xef\xbb\xbf"


class RepoTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="copyright-test-")
        self.root = Path(self._tmp.name)
        self.git("init", "-q")

    def tearDown(self):
        self._tmp.cleanup()

    # -- helpers ---------------------------------------------------------
    def git(self, *args):
        return subprocess.run(
            ["git", "-c", "core.autocrlf=false", "-c", "user.email=test@example.com",
             "-c", "user.name=Test", *args],
            cwd=self.root, capture_output=True, text=True, check=True)

    def write(self, rel, content):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content, encoding="utf-8", newline="")
        return path

    def stage(self):
        self.git("add", "-A")

    def run_check(self, *args, cwd=None):
        # The child prints tracked paths, which may be non-ASCII. Pin its stdio
        # to UTF-8 so the assertion sees the path rather than the console
        # encoding (Windows defaults to a legacy code page).
        env = dict(os.environ, PYTHONIOENCODING="utf-8")
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=cwd or self.root, capture_output=True, text=True, encoding="utf-8",
            errors="replace", env=env)

    def assert_passes(self, *args):
        proc = self.run_check(*args)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return proc

    def assert_fails(self, *args):
        proc = self.run_check(*args)
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        return proc

    def base_file(self, rel="src/a.ts", header=TS_HEADER):
        return self.write(rel, f"{header}\n\nexport const x = 1;\n")

    # -- the positive and negative cases ---------------------------------
    def test_correct_header_passes(self):
        self.base_file()
        self.stage()
        proc = self.assert_passes()
        self.assertIn("All 1 checked source files", proc.stdout)

    def test_missing_header_fails_and_names_the_file(self):
        self.write("src/a.ts", "export const x = 1;\n")
        self.stage()
        proc = self.assert_fails()
        self.assertIn("src/a.ts", proc.stdout)
        self.assertIn("missing the copyright header", proc.stdout)

    def test_check_never_modifies_a_file(self):
        path = self.write("src/a.ts", "export const x = 1;\n")
        self.stage()
        before = path.read_bytes()
        self.assert_fails()
        self.assertEqual(path.read_bytes(), before)

    def test_fix_inserts_and_is_idempotent(self):
        path = self.write("src/a.ts", "export const x = 1;\n")
        self.stage()
        self.assert_passes("--fix")
        fixed = path.read_bytes()
        self.assertEqual(fixed, (TS_HEADER + "\n\nexport const x = 1;\n").encode())
        # Second run changes nothing and passes.
        self.assert_passes("--fix")
        self.assertEqual(path.read_bytes(), fixed)

    def test_new_file_is_caught_after_a_passing_run(self):
        self.base_file()
        self.stage()
        self.assert_passes()
        self.write("src/b.ts", "export const y = 2;\n")
        self.stage()
        self.assert_fails()

    def test_modified_file_losing_its_header_is_caught(self):
        path = self.base_file()
        self.stage()
        self.assert_passes()
        path.write_text("export const x = 2;\n", encoding="utf-8")
        self.stage()
        self.assert_fails()

    # -- file-type policy ------------------------------------------------
    def test_markdown_is_not_required(self):
        self.base_file()
        self.write("README.md", "---\ntitle: Read me\n---\n\n# Hi\n")
        self.stage()
        proc = self.assert_passes()
        self.assertNotIn("README.md", proc.stdout)

    def test_configuration_files_are_not_required(self):
        self.base_file()
        self.write("package.json", '{"name": "x"}\n')
        self.write("ci.yml", "name: CI\n")
        self.stage()
        proc = self.assert_passes()
        self.assertNotIn("package.json", proc.stdout)
        self.assertNotIn("ci.yml", proc.stdout)

    def test_unsupported_extension_is_not_required(self):
        self.base_file()
        self.write("notes.xyz", "hello\n")
        self.stage()
        proc = self.assert_passes()
        self.assertNotIn("notes.xyz", proc.stdout)

    def test_empty_file_is_ignored(self):
        self.base_file()
        self.write("src/empty.ts", "")
        self.stage()
        self.assert_passes()

    def test_unicode_and_space_in_path_is_checked(self):
        self.write("src/über file.ts", "export const x = 1;\n")
        self.stage()
        proc = self.assert_fails()
        self.assertIn("über file.ts", proc.stdout)
        self.assert_passes("--fix")

    def test_subdirectory_invocation_scans_and_fixes_the_entire_repository(self):
        missing = self.write("src/missing.ts", "export const missing = true;\n")
        self.base_file("subdir/present.ts")
        self.stage()

        proc = self.run_check(cwd=self.root / "subdir")
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("src/missing.ts", proc.stdout)

        fixed = self.run_check("--fix", cwd=self.root / "subdir")
        self.assertEqual(fixed.returncode, 0, fixed.stdout + fixed.stderr)
        self.assertEqual(
            missing.read_bytes(),
            (TS_HEADER + "\n\nexport const missing = true;\n").encode(),
        )

    # -- order-sensitive first lines -------------------------------------
    def test_shebang_stays_on_line_one(self):
        path = self.write("scripts/run.sh", "#!/usr/bin/env bash\nset -e\n")
        self.stage()
        self.assert_passes("--fix")
        self.assertEqual(path.read_text(encoding="utf-8"),
                         "#!/usr/bin/env bash\n" + SH_HEADER + "\n\nset -e\n")

    def test_python_coding_declaration_stays_within_line_two(self):
        path = self.write("tool.py", "#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\nprint(1)\n")
        self.stage()
        self.assert_passes("--fix")
        self.assertEqual(
            path.read_text(encoding="utf-8"),
            "#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n" + SH_HEADER + "\n\nprint(1)\n")

    def test_batch_echo_off_stays_first(self):
        path = self.write("run.cmd", "@echo off\nrem body\n")
        self.stage()
        self.assert_passes("--fix")
        self.assertTrue(path.read_text(encoding="utf-8").startswith("@echo off\n@REM " + HEADER))

    # -- byte-level preservation ----------------------------------------
    def test_utf8_bom_is_preserved(self):
        path = self.write("src/bom.ts", BOM + b"export const x = 1;\n")
        self.stage()
        self.assert_passes("--fix")
        data = path.read_bytes()
        self.assertTrue(data.startswith(BOM + TS_HEADER.encode() + b"\n\n"))
        self.assert_passes()

    def test_bom_with_shebang_keeps_both(self):
        path = self.write("src/main.ts", BOM + b"#!/usr/bin/env node\nrun();\n")
        self.stage()
        self.assert_passes("--fix")
        data = path.read_bytes()
        self.assertTrue(data.startswith(BOM + b"#!/usr/bin/env node\n" + TS_HEADER.encode()))

    def test_crlf_is_preserved(self):
        path = self.write("src/crlf.ts", b"export const x = 1;\r\n")
        self.stage()
        self.assert_passes("--fix")
        self.assertEqual(path.read_bytes(),
                         (TS_HEADER + "\r\n\r\nexport const x = 1;\r\n").encode())

    def test_invalid_utf8_is_reported_and_not_fixed(self):
        self.base_file()
        path = self.write("src/latin1.ts", b"// caf\xe9\n")
        self.stage()
        before = path.read_bytes()
        proc = self.assert_fails("--fix")
        self.assertIn("not valid UTF-8", proc.stdout)
        self.assertEqual(path.read_bytes(), before)

    # -- existing notices are never duplicated ----------------------------
    def test_wrong_copyright_is_reported_and_not_fixed(self):
        path = self.write("src/old.ts", "// Copyright 2025 Ix Infrastructure LLC\n\nexport const x = 1;\n")
        self.stage()
        before = path.read_bytes()
        proc = self.assert_fails("--fix")
        self.assertIn("src/old.ts", proc.stdout)
        self.assertEqual(path.read_bytes(), before)
        self.assertNotIn("Copyright 2026", path.read_text(encoding="utf-8"))

    def test_header_below_line_five_is_not_duplicated(self):
        text = ("// a note\n// another\n// third\n// fourth\n// fifth\n"
                "// sixth\n" + TS_HEADER + "\n\nexport const x = 1;\n")
        path = self.write("src/low.ts", text)
        self.stage()
        self.assert_fails()
        self.assert_fails("--fix")
        self.assertEqual(path.read_text(encoding="utf-8").count(HEADER), 1)

    def test_wrong_copyright_below_line_five_is_not_fixed(self):
        text = ("// note\n" * 6
                + "// Copyright 2025 Ix Infrastructure LLC\n\nexport const x = 1;\n")
        path = self.write("src/low-wrong.ts", text)
        self.stage()
        before = path.read_bytes()
        proc = self.assert_fails("--fix")
        self.assertIn("src/low-wrong.ts", proc.stdout)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(path.read_text(encoding="utf-8").count("Copyright"), 1)

    def test_prose_mention_of_copyright_is_not_a_notice(self):
        self.write("src/prose.ts", TS_HEADER + "\n\n"
                   "// This copyright policy is documented elsewhere.\n")
        self.stage()
        self.assert_passes()

    def test_extra_notice_below_a_correct_header_is_reported(self):
        text = (TS_HEADER + "\n\n" + "// note\n" * 6
                + "// Copyright 2025 Ix Infrastructure LLC\n\nexport const x = 1;\n")
        path = self.write("src/correct-then-wrong.ts", text)
        self.stage()
        before = path.read_bytes()
        proc = self.assert_fails("--fix")
        self.assertIn("more than one copyright notice", proc.stdout)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(path.read_text(encoding="utf-8").count("Copyright"), 2)

    # -- exclusions ------------------------------------------------------
    def test_license_and_notice_files_are_ignored(self):
        self.base_file()
        self.write("LICENSE", "Apache License\n")
        self.write("NOTICE", "Copyright 2026 Ix Infrastructure Inc.\n")
        self.stage()
        self.assert_passes()

    def test_generated_output_paths_are_ignored(self):
        self.base_file()
        self.write("dist/bundle.js", "console.log(1)\n")
        self.write("build/out.js", "console.log(1)\n")
        self.stage()
        self.assert_passes()

    def test_vendored_paths_are_ignored(self):
        self.base_file()
        self.write("vendor/lib.ts", "export const x = 1;\n")
        self.write("third_party/lib.ts", "export const x = 1;\n")
        self.stage()
        self.assert_passes()

    def test_fixture_paths_are_ignored(self):
        self.base_file()
        self.write("test-fixtures/case.ts", "export const x = 1;\n")
        self.write("src/__tests__/fixtures/case.ts", "export const x = 1;\n")
        self.stage()
        self.assert_passes()

    def test_linguist_generated_attribute_values_are_ignored(self):
        self.base_file()
        self.write(".gitattributes",
                   "*.set.ts linguist-generated\n"
                   "*.true.ts linguist-generated=true\n"
                   "*.one.ts linguist-generated=1\n"
                   "*.yes.ts linguist-generated=yes\n")
        for name in ("set", "true", "one", "yes"):
            self.write(f"src/schema.{name}.ts", "export const x = 1;\n")
        self.stage()
        proc = self.assert_passes()
        self.assertIn("All 1 checked source files", proc.stdout)

    def test_linguist_generated_true_value_is_ignored(self):
        self.base_file()
        self.write(".gitattributes", "*.gen.ts linguist-generated=true\n")
        self.write("src/schema.gen.ts", "export const x = 1;\n")
        self.stage()
        proc = self.assert_passes()
        self.assertIn("All 1 checked source files", proc.stdout)

    def test_generated_attribute_handles_space_and_unicode(self):
        self.base_file()
        self.write(".gitattributes", "*.gen.ts linguist-generated\n")
        self.write("src/über file.gen.ts", "export const x = 1;\n")
        self.stage()
        proc = self.assert_passes()
        self.assertIn("All 1 checked source files", proc.stdout)

    @unittest.skipIf(os.name == "nt", "Windows rejects newline characters in file names")
    def test_generated_attribute_handles_newline(self):
        self.base_file()
        self.write(".gitattributes", "*.gen.ts linguist-generated\n")
        self.write("src/line\nbreak.gen.ts", "export const x = 1;\n")
        self.stage()
        proc = self.assert_passes()
        self.assertIn("All 1 checked source files", proc.stdout)

    # -- the gate must be able to fail loudly ----------------------------
    def test_empty_scope_fails_loudly(self):
        self.write("README.md", "# docs only\n")
        self.stage()
        proc = self.assert_fails()
        self.assertIn("no source files found", proc.stderr)

    def test_unknown_argument_is_rejected(self):
        self.base_file()
        self.stage()
        proc = self.run_check("--fi")
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn("unknown argument", proc.stderr)

    def test_non_git_directory_fails_loudly(self):
        with tempfile.TemporaryDirectory(prefix="copyright-nongit-") as directory:
            proc = self.run_check(cwd=Path(directory))
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("could not determine the Git repository root", proc.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
