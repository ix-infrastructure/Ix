# Copyright 2026 Ix Infrastructure Inc.

class Ix < Formula
  desc "Persistent memory for LLM systems — CLI for the Ix knowledge graph"
  homepage "https://github.com/ix-infrastructure/Ix"
  url "https://github.com/ix-infrastructure/Ix/archive/refs/tags/v0.14.0.tar.gz"
  sha256 "d15c309995215746f6714253a9506accea27bc5e853d67ac41d44211a89ede09"
  license "Apache-2.0"
  head "https://github.com/ix-infrastructure/Ix.git", branch: "main"

  depends_on "node@22"

  def install
    # Build what the release job (.github/workflows/release.yml) builds: npm ci
    # from the lockfiles, `npm run build`, then dev dependencies pruned. Any
    # other recipe ships a different artefact from the release archives (#977).
    cd "core-ingestion" do
      # Installs and compiles the native tree-sitter bindings. ix-cli's
      # `npm run build` below then builds core-ingestion's dist/; its
      # build-core-ingestion.mjs skips its own `npm ci` because node_modules
      # already exists, so nothing is compiled twice.
      system "npm", "ci", "--silent"
    end

    cd "ix-cli" do
      system "npm", "ci", "--silent"
      # Builds core-ingestion, compiles with tsconfig.build.json (the test files
      # stay out of dist/) and copies the backend compose file that
      # `ix docker start` writes out into dist/.
      system "npm", "run", "build"
      # Sync package.json version with the formula version
      system "npm", "version", version.to_s, "--no-git-tag-version", "--allow-same-version"
      # The build has used the toolchain; ship the runtime dependencies only.
      system "npm", "prune", "--omit=dev"

      # Install the compiled CLI and its dependencies
      libexec.install "dist", "node_modules", "package.json"

      # ...and the banner inputs, which are part of the CLI, not extras.
      # `banner.js` resolves them as join(dirname(import.meta.url), "..", "..")
      # -- i.e. libexec -- so without these the setup notice silently falls back
      # to the plain text heading on every Homebrew install. Silently is the
      # problem: renderBanner() is absent-safe by design and returns null rather
      # than failing, so a missing input looks exactly like success.
      #
      # Ix#605 shipped this for the npm tarball and the release staging and
      # missed Homebrew, which is a third delivery path with its own layout.
      # Copied file-by-file rather than as whole directories: ix-cli/scripts/
      # also holds the CI parity checkers and the core-ingestion build script,
      # none of which belong in an installed prefix.
      (libexec/"scripts").install "scripts/render-logo.mjs", "scripts/render-logo.d.mts"
      (libexec/"assets").install "assets/logo.png"

      # Create a wrapper script that invokes node with the correct path
      (bin/"ix").write <<~EOS
        #!/bin/bash
        exec "#{Formula["node@22"].opt_bin}/node" "#{libexec}/dist/cli/main.js" "$@"
      EOS
    end

    # Only now that ix-cli has built. `install` moves files, and ix-cli's
    # `npm run build` builds core-ingestion in place from its node_modules, so
    # moving or pruning core-ingestion any earlier breaks that build (the
    # review of #1073 found the same order bug).
    cd "core-ingestion" do
      system "npm", "prune", "--omit=dev"
      # tree-sitter-cli arrives transitively as a runtime dependency but is
      # grammar-authoring tooling that nothing runs at run time. The release
      # job deletes it too.
      rm_r Dir["node_modules/tree-sitter-cli", "node_modules/.bin/tree-sitter"]
    end

    # Install core-ingestion runtime (parser + tree-sitter grammars)
    # The CLI loads these at runtime via a relative path from dist/cli/commands/
    (prefix/"core-ingestion").install Dir["core-ingestion/dist", "core-ingestion/node_modules", "core-ingestion/package.json"]
  end

  def caveats
    <<~EOS
      The ix CLI is installed. To start the backend:

        ix docker start

      This requires Docker Desktop to be running.
      The backend runs as two containers: ArangoDB + Memory Layer.

      The graph visualizer used by `ix view` (System Compass) is not part of
      this formula. Fetch it into ~/.ix/cli/compass with:

        ix upgrade

      That also updates the backend. The CLI itself stays with `brew upgrade ix`.
    EOS
  end

  test do
    # `ix --help` renders a custom help screen (buildHelpText) that has never
    # contained the word "Usage:", so the previous assertion could only fail.
    # --version is both stable and meaningful: the install step above syncs
    # package.json to the formula version, so this proves the built CLI runs
    # *and* that it is the version brew thinks it installed.
    assert_match version.to_s, shell_output("#{bin}/ix --version")

    # --version never loads core-ingestion: the CLI reaches it through a dynamic
    # import on the first `ix map`. So parse something, as the release job does
    # after its prune, to prove the pruned grammars still load.
    (testpath/"parse.mjs").write <<~EOS
      const { parseFile } = await import("#{prefix}/core-ingestion/dist/index.js");
      await import("#{prefix}/core-ingestion/dist/patch-builder.js");
      if (!parseFile("smoke.ts", "export const smoke = 1;\\n")) throw new Error("core-ingestion parsed nothing");
      console.log("parsed");
    EOS
    assert_equal "parsed", shell_output("#{Formula["node@22"].opt_bin}/node #{testpath}/parse.mjs").strip

    # npm run build compiles with tsconfig.build.json, so no tests ship...
    assert_empty Dir["#{libexec}/dist/**/__tests__"]
    # ...and copies in the compose file `ix docker start` writes out.
    assert_path_exists libexec/"dist/docker-compose.standalone.yml"
  end
end
