class Ix < Formula
  desc "Persistent memory for LLM systems — CLI for the Ix knowledge graph"
  homepage "https://github.com/ix-infrastructure/Ix"
  url "https://github.com/ix-infrastructure/Ix/archive/refs/tags/v0.3.3.tar.gz"
  sha256 "1296697b2b8a71e4b1b270514c9e7560506f2d078e88f2dd872891bcabe864e9"
  license "MIT"
  head "https://github.com/ix-infrastructure/Ix.git", branch: "main"

  depends_on "node@22"

  def install
    cd "ix-cli" do
      system "npm", "install", "--production", "--silent"
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
