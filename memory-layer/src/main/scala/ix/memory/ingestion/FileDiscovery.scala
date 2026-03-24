package ix.memory.ingestion

import java.nio.file.{Files, Path}

/**
 * Discovers source files for ingestion.
 *
 * Primary strategy: `git ls-files` — respects .gitignore, fast, works for any repo.
 * Fallback: manual file walk with hardcoded ignore list (for non-git directories).
 */
object FileDiscovery {

  private val defaultExtensions = Set(
    ".py", ".ts", ".tsx",
    ".scala", ".sc",
    ".json", ".yaml", ".yml", ".toml",
    ".md"
  )

  def extensionsFor(language: Option[String]): Set[String] = language match {
    case Some("python")     => Set(".py")
    case Some("typescript") => Set(".ts", ".tsx")
    case Some("javascript") => Set(".js", ".jsx", ".mjs", ".cjs")
    case Some("scala")      => Set(".scala", ".sc")
    case Some("java")       => Set(".java")
    case Some("go")         => Set(".go")
    case Some("rust")       => Set(".rs")
    case Some("ruby")       => Set(".rb")
    case Some("config")     => Set(".json", ".yaml", ".yml", ".toml", ".ini", ".conf", ".properties", ".xml")
    case Some("markdown")   => Set(".md", ".mdx")
    case _                  => defaultExtensions
  }

  def matchesFilter(file: Path, extensions: Set[String]): Boolean = {
    val name = file.getFileName.toString
    extensions.exists(name.endsWith)
  }

  /**
   * Use `git ls-files` to discover tracked files. Returns None if not a git repo
   * or git is not available.
   */
  def tryGitLsFiles(dir: Path, recursive: Boolean, extensions: Set[String]): Option[List[Path]] = {
    try {
      val pb = new ProcessBuilder("git", "ls-files", "--cached", "--others", "--exclude-standard")
      pb.directory(dir.toFile)
      pb.redirectErrorStream(true)
      val proc = pb.start()
      val reader = new java.io.BufferedReader(
        new java.io.InputStreamReader(proc.getInputStream, java.nio.charset.StandardCharsets.UTF_8)
      )
      val result = scala.collection.mutable.ListBuffer.empty[Path]

      try {
        var line = reader.readLine()
        while (line != null) {
          if (line.nonEmpty) {
            val p = dir.resolve(line).normalize()
            val isUnder = if (recursive) true else p.getParent == dir
            if (isUnder && Files.isRegularFile(p) && matchesFilter(p, extensions)) {
              result += p
            }
          }
          line = reader.readLine()
        }
      } finally {
        reader.close()
      }

      val exitCode = proc.waitFor()
      if (exitCode != 0) None else Some(result.toList)
    } catch {
      case _: Throwable => None
    }
  }

  /**
   * Fallback: walk the directory tree, skipping common non-source directories.
   */
  def walkFiles(dir: Path, recursive: Boolean, extensions: Set[String]): List[Path] = {
    import scala.jdk.CollectionConverters._

    if (!recursive) {
      val stream = Files.list(dir)
      try {
        stream.iterator().asScala
          .filter(Files.isRegularFile(_))
          .filter(matchesFilter(_, extensions))
          .toList
      } finally stream.close()
    } else {
      // Directories to skip when not using git
      val ignoredDirs = Set(
        "node_modules", ".git", ".hg", ".svn",
        "target", "dist", "build", "out", ".next",
        "__pycache__", ".tox", ".venv", "venv", ".mypy_cache", ".pytest_cache",
        ".gradle", ".idea", ".vscode", ".settings", ".vs",
        ".cache", ".parcel-cache", "coverage", ".nyc_output",
        "vendor", "Pods", ".dart_tool", ".pub-cache",
        "bin", "obj", "pkg"
      )
      val result = scala.collection.mutable.ListBuffer.empty[Path]
      Files.walkFileTree(dir, new java.nio.file.SimpleFileVisitor[Path] {
        override def preVisitDirectory(d: Path, attrs: java.nio.file.attribute.BasicFileAttributes): java.nio.file.FileVisitResult = {
          val name = d.getFileName.toString
          if (d != dir && (ignoredDirs.contains(name) || name.startsWith(".")))
            java.nio.file.FileVisitResult.SKIP_SUBTREE
          else
            java.nio.file.FileVisitResult.CONTINUE
        }
        override def visitFile(file: Path, attrs: java.nio.file.attribute.BasicFileAttributes): java.nio.file.FileVisitResult = {
          if (matchesFilter(file, extensions))
            result += file
          java.nio.file.FileVisitResult.CONTINUE
        }
      })
      result.toList
    }
  }
}
