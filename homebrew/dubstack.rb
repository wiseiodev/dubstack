class Dubstack < Formula
  desc "CLI for managing stacked diffs (dependent git branches)"
  homepage "https://github.com/wiseiodev/dubstack"
  url "https://registry.npmjs.org/dubstack/-/dubstack-0.1.0.tgz"
  sha256 "PLACEHOLDER"
  license "MIT"

  depends_on "node"

  conflicts_with "dub", because: "both install a `dub` binary"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")

    # Generate the man page and shell completions from the installed binary
    # so they always match the version users are running. `err: :merge` folds
    # any stderr into the captured output so a failed `dub man` surfaces
    # during `brew test` instead of silently writing a partial man page.
    man1.mkpath
    (man1/"dub.1").write Utils.safe_popen_read(bin/"dub", "man", err: :merge)
    generate_completions_from_executable(bin/"dub", "completion")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/dub --version")
    assert_match ".TH DUB 1", shell_output("#{bin}/dub man")
  end
end
