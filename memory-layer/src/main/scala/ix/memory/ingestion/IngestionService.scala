package ix.memory.ingestion

import java.nio.file.{Files, Path}

import cats.effect.IO
import cats.syntax.all._
import ix.memory.db.{CommitResult, GraphWriteApi}
import ix.memory.model.Rev

/**
 * Orchestrates file ingestion: reads source files, parses them,
 * builds graph patches, and commits them through the write API.
 */
class IngestionService(parserRouter: ParserRouter, writeApi: GraphWriteApi) {

  /**
   * Ingest a single file: read, parse, build patch, commit.
   */
  def ingestFile(filePath: Path): IO[CommitResult] = {
    for {
      source <- IO.blocking {
        val s = scala.io.Source.fromFile(filePath.toFile)
        try s.mkString finally s.close()
      }
      parser <- IO.fromOption(parserRouter.parserFor(filePath.toString))(
        new IllegalArgumentException(s"No parser for: $filePath")
      )
      result  = parser.parse(filePath.getFileName.toString, source)
      hash    = Some(
        java.security.MessageDigest.getInstance("SHA-256")
          .digest(source.getBytes("UTF-8"))
          .map("%02x".format(_))
          .mkString
      )
      patch   = GraphPatchBuilder.build(filePath.toString, hash, result)
      _      <- IO.fromEither(PatchValidator.validate(patch).left.map(msg => new IllegalStateException(msg)))
      commit <- writeApi.commitPatch(patch)
    } yield commit
  }

  /**
   * Ingest all matching files under a path.
   *
   * @param path      root directory or single file
   * @param language  optional language filter (e.g. "python")
   * @param recursive whether to recurse into subdirectories
   * @return aggregated ingestion result
   */
  def ingestPath(
    path:      Path,
    language:  Option[String],
    recursive: Boolean
  ): IO[IngestionResult] = {
    for {
      files   <- discoverFiles(path, language, recursive)
      results <- files.traverse(f => ingestFile(f).attempt)
      successes = results.collect { case Right(cr) => cr }
      latestRev = successes.lastOption.map(_.newRev).getOrElse(Rev(0L))
    } yield IngestionResult(
      filesProcessed  = files.size,
      patchesApplied  = successes.size,
      entitiesCreated = 0, // Would need to count from parse results
      latestRev       = latestRev
    )
  }

  private def discoverFiles(
    path:      Path,
    language:  Option[String],
    recursive: Boolean
  ): IO[List[Path]] = IO.blocking {
    import scala.jdk.CollectionConverters._

    val extensions = language match {
      case Some("python") => Set(".py")
      case _              => Set(".py") // default: all supported extensions
    }

    if (Files.isRegularFile(path)) {
      if (extensions.exists(ext => path.toString.endsWith(ext))) List(path)
      else List.empty
    } else if (Files.isDirectory(path)) {
      val stream = if (recursive) Files.walk(path) else Files.list(path)
      try {
        stream.iterator().asScala
          .filter(p => Files.isRegularFile(p))
          .filter(p => extensions.exists(ext => p.toString.endsWith(ext)))
          .toList
      } finally {
        stream.close()
      }
    } else {
      List.empty
    }
  }
}

case class IngestionResult(
  filesProcessed:  Int,
  patchesApplied:  Int,
  entitiesCreated: Int,
  latestRev:       Rev
)
