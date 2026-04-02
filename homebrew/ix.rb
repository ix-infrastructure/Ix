class Ix < Formula
  desc "Persistent memory for LLM systems — CLI for the Ix knowledge graph"
  homepage "https://github.com/ix-infrastructure/Ix"
  url "https://github.com/ix-infrastructure/Ix/archive/refs/tags/v0.3.4.tar.gz"
  sha256 "32bfaa786849230d3ee72198b0a89ce7706dfd011c9919d69fc9929265c10fa7"
  license "Apache-2.0"
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

    # Install Docker Compose file for the backend (ix docker start)
    (var/"ix/backend").mkpath
    (var/"ix/backend/docker-compose.yml").write (buildpath/"docker-compose.standalone.yml").read
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
