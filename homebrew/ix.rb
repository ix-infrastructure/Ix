class Ix < Formula
  desc "Persistent memory for LLM systems — CLI for the Ix knowledge graph"
  homepage "https://github.com/ix-infrastructure/Ix"
  url "https://github.com/ix-infrastructure/Ix/archive/refs/tags/v0.4.0.tar.gz"
  sha256 "34cc5b9b3ef53e8dbb3ce74ba2459224d4f74bdb318a0ea4b116dcc6b1d38d75"
  license "MIT"
  head "https://github.com/ix-infrastructure/Ix.git", branch: "main"

  depends_on "node@22"

  def install
    # core-ingestion must be built first — the CLI build depends on it
    cd "core-ingestion" do
      system "npm", "install", "--silent"
      system "npm", "run", "build"
    end

    cd "ix-cli" do
      system "npm", "install", "--silent"
      system "npm", "run", "build"

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
    assert_match "Usage:", shell_output("#{bin}/ix --help")
  end
end
