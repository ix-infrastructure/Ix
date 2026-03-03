package ix.memory.ingestion

import java.nio.file.{Files, Path}

import cats.effect.IO
import cats.syntax.all._
import ix.memory.db.{CommitResult, GraphQueryApi, GraphWriteApi}
import ix.memory.model.{PatchId, Rev}

/**
 * Orchestrates file ingestion: reads source files, parses them,
 * builds graph patches, and commits them through the write API.
 */
class IngestionService(parserRouter: ParserRouter, writeApi: GraphWriteApi, queryApi: GraphQueryApi) {

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
      // Check for existing patch from same source+extractor
      extractor = if (filePath.toString.endsWith(".py")) "tree-sitter-python/1.0"
                  else if (filePath.toString.endsWith(".ts") || filePath.toString.endsWith(".tsx")) "typescript-parser/1.0"
                  else "unknown-parser/1.0"
      existing <- queryApi.getPatchesBySource(filePath.toString, extractor)
      prevPatch = existing.headOption
      prevHash  = prevPatch.flatMap(_.hcursor.downField("data").downField("source").get[String]("sourceHash").toOption)
      // If hash unchanged, skip (idempotent)
      _ <- if (prevHash == hash) IO.raiseError(new RuntimeException("Idempotent — file unchanged"))
           else IO.unit
      prevPatchId = prevPatch.flatMap(_.hcursor.downField("data").get[String]("patchId").toOption)
                      .flatMap(s => scala.util.Try(java.util.UUID.fromString(s)).toOption)
                      .map(PatchId(_))
      replaces = prevPatchId.toVector
      patch   = GraphPatchBuilder.build(filePath.toString, hash, result).copy(replaces = replaces)
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
      idempotentCount = results.count {
        case Left(e: RuntimeException) if e.getMessage.startsWith("Idempotent") => true
        case _ => false
      }
      latestRev = successes.lastOption.map(_.newRev).getOrElse(Rev(0L))
    } yield IngestionResult(
      filesProcessed  = files.size,
      patchesApplied  = successes.size,
      filesSkipped    = idempotentCount,
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
      case Some("python")     => Set(".py")
      case Some("typescript") => Set(".ts", ".tsx")
      case _                  => Set(".py", ".ts", ".tsx") // all supported
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
  filesSkipped:    Int,
  entitiesCreated: Int,
  latestRev:       Rev
)
