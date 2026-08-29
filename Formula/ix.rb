class Ix < Formula
  desc "Persistent memory for LLM systems — CLI for the Ix knowledge graph"
  homepage "https://github.com/ix-infrastructure/Ix"
  url "https://github.com/ix-infrastructure/Ix/archive/refs/tags/v0.10.5.tar.gz"
  sha256 "68dde32b8d6ee5f58971a1559c1e7b1ff74b4d41d4e739c4d9b7543f895cbc51"
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
