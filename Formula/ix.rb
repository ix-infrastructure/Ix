class Ix < Formula
  desc "Persistent memory for LLM systems — CLI for the Ix knowledge graph"
  homepage "https://github.com/ix-infrastructure/Ix"
  url "https://github.com/ix-infrastructure/Ix/archive/refs/tags/v0.10.8.tar.gz"
  sha256 "68eaec38dd23e0119ae237cae799fd004c719caf4e27b30a531ed925fe51fbf7"
  license "Apache-2.0"
  head "https://github.com/ix-infrastructure/Ix.git", branch: "main"

  depends_on "node@22"

  def install
    # core-ingestion must be built first — the CLI build depends on it
    cd "core-ingestion" do
      system "npm", "install", "--silent"
      system "npm", "run", "build"
    end

    # Install core-ingestion runtime (parser + tree-sitter grammars)
    # The CLI loads these at runtime via a relative path from dist/cli/commands/
    (prefix/"core-ingestion").install Dir["core-ingestion/dist", "core-ingestion/node_modules", "core-ingestion/package.json"]

    cd "ix-cli" do
      system "npm", "install", "--silent"
      # Sync package.json version with the formula version
      system "npm", "version", version.to_s, "--no-git-tag-version", "--allow-same-version"
      # Run tsc directly — npm run build would redundantly rebuild core-ingestion
      # via build-core-ingestion.mjs, which triggers native module compilation
      system "npx", "tsc"

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
  end

  def caveats
    <<~EOS
      The ix CLI is installed. To start the backend:

        ix docker start

      This requires Docker Desktop to be running.
      The backend runs as two containers: ArangoDB + Memory Layer.
    EOS
  end

  test do
    # `ix --help` renders a custom help screen (buildHelpText) that has never
    # contained the word "Usage:", so the previous assertion could only fail.
    # --version is both stable and meaningful: the install step above syncs
    # package.json to the formula version, so this proves the built CLI runs
    # *and* that it is the version brew thinks it installed.
    assert_match version.to_s, shell_output("#{bin}/ix --version")
  end
end
