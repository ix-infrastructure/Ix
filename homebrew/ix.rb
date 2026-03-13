class Ix < Formula
  desc "Persistent memory for LLM systems — CLI for the Ix knowledge graph"
  homepage "https://github.com/ix-infrastructure/IX-Memory"
  version "0.1.0"
  license "MIT"

  if OS.mac?
    if Hardware::CPU.arm?
      url "https://github.com/ix-infrastructure/IX-Memory/releases/download/v0.1.0/ix-darwin-arm64.tar.gz"
      sha256 "PLACEHOLDER_SHA256_DARWIN_ARM64" # TODO: update after release
    else
      url "https://github.com/ix-infrastructure/IX-Memory/releases/download/v0.1.0/ix-darwin-x64.tar.gz"
      sha256 "PLACEHOLDER_SHA256_DARWIN_X64" # TODO: update after release
    end
  elsif OS.linux?
    if Hardware::CPU.arm?
      url "https://github.com/ix-infrastructure/IX-Memory/releases/download/v0.1.0/ix-linux-arm64.tar.gz"
      sha256 "PLACEHOLDER_SHA256_LINUX_ARM64" # TODO: update after release
    else
      url "https://github.com/ix-infrastructure/IX-Memory/releases/download/v0.1.0/ix-linux-x64.tar.gz"
      sha256 "PLACEHOLDER_SHA256_LINUX_X64" # TODO: update after release
    end
  end

  depends_on "node@22"

  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"ix"
  end

  test do
    system "#{bin}/ix", "--version"
  end
end
