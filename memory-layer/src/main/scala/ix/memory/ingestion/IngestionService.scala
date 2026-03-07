package ix.memory.ingestion

import java.nio.file.{Files, Path}
import java.time.Instant
import java.util.UUID

import cats.effect.IO
import cats.syntax.all._
import ix.memory.db.{CommitResult, GraphQueryApi, GraphWriteApi}
import ix.memory.model._
import io.circe.Json

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
      bytes <- IO.blocking(Files.readAllBytes(filePath))
      _     <- if (bytes.isEmpty) IO.raiseError(new RuntimeException(s"Skipping empty file: $filePath"))
               else IO.unit
      // Hash raw bytes so revisions are stable across encodings
      hash = Some(sha256Bytes(bytes))
      // Decode text with UTF-8, fallback to ISO-8859-1 to avoid hard failures
      source <- IO.blocking {
        try new String(bytes, java.nio.charset.StandardCharsets.UTF_8)
        catch { case _: Throwable => new String(bytes, java.nio.charset.StandardCharsets.ISO_8859_1) }
      }
      // Use the language-specific parser when available; otherwise fall back to generic text
      parserOpt = parserRouter.parserFor(filePath.toString)
      result = parserOpt match {
        case Some(p) => p.parse(filePath.getFileName.toString, source)
        case None    => genericTextParse(filePath.getFileName.toString, source)
      }
      val fp = filePath.toString
      extractor = if (fp.endsWith(".py")) "tree-sitter-python/1.0"
                  else if (fp.endsWith(".ts") || fp.endsWith(".tsx")) "typescript-parser/1.0"
                  else if (fp.endsWith(".scala") || fp.endsWith(".sc")) "scala-parser/1.0"
                  else if (fp.endsWith(".json") || fp.endsWith(".yaml") || fp.endsWith(".yml") || fp.endsWith(".toml") || fp.endsWith(".ini") || fp.endsWith(".conf") || fp.endsWith(".properties") || fp.endsWith(".env")) "config-parser/1.0"
                  else if (fp.endsWith(".md") || fp.endsWith(".mdx") || fp.endsWith(".rst") || fp.endsWith(".txt")) "markdown-parser/1.0"
                  else "text-parser/1.0"
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
      // Resolve cross-file import edges after main patch is committed
      _      <- resolveImportEdges(filePath, result, hash).attempt.void
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
    val extensions = FileDiscovery.extensionsFor(language)
    if (Files.isRegularFile(path)) {
      if (FileDiscovery.matchesFilter(path, extensions)) List(path) else List.empty
    } else if (Files.isDirectory(path)) {
      FileDiscovery.tryGitLsFiles(path, recursive, extensions)
        .getOrElse(FileDiscovery.walkFiles(path, recursive, extensions))
    } else {
      List.empty
    }
  }

  private def resolveImportEdges(
    filePath:   Path,
    parseResult: ParseResult,
    sourceHash: Option[String]
  ): IO[Unit] = {
    val importRels = parseResult.relationships.filter(_.predicate == "IMPORTS")
    importRels.traverse_ { rel =>
      val targetName = rel.dstName
      // Try to resolve relative imports (./config, ../utils)
      val resolvedPath = resolveRelativePath(filePath, targetName)
      resolvedPath match {
        case Some(resolved) =>
          queryApi.searchNodes(resolved.getFileName.toString, limit = 1).flatMap {
            case nodes if nodes.nonEmpty =>
              val srcId = NodeId(UUID.nameUUIDFromBytes(s"${filePath}:${filePath.getFileName}".getBytes("UTF-8")))
              val dstId = nodes.head.id
              val edgeId = EdgeId(UUID.nameUUIDFromBytes(s"${srcId.value}:${dstId.value}:IMPORTS".getBytes("UTF-8")))
              val patch = GraphPatch(
                patchId   = PatchId(UUID.randomUUID()),
                actor     = "ix/cross-file",
                timestamp = Instant.now(),
                source    = PatchSource(filePath.toString, sourceHash, "cross-file-resolver/1.0", SourceType.Code),
                baseRev   = Rev(0L),
                ops       = Vector(PatchOp.UpsertEdge(edgeId, srcId, dstId, EdgePredicate("IMPORTS"), Map.empty)),
                replaces  = Vector.empty,
                intent    = Some(s"Cross-file import: ${filePath.getFileName} -> ${resolved.getFileName}")
              )
              writeApi.commitPatch(patch).void
            case _ => IO.unit
          }
        case None => IO.unit
      }
    }
  }

  private def resolveRelativePath(from: Path, importTarget: String): Option[Path] = {
    if (importTarget.startsWith("./") || importTarget.startsWith("../")) {
      val base = from.getParent
      if (base == null) return None
      val extensions = List("", ".ts", ".tsx", ".scala", ".py", ".js")
      extensions.collectFirst {
        case ext =>
          val candidate = base.resolve(importTarget + ext).normalize()
          if (Files.exists(candidate)) candidate else null
      }.flatMap(Option(_))
    } else None
  }

  private def sha256Bytes(bytes: Array[Byte]): String = {
    val md = java.security.MessageDigest.getInstance("SHA-256")
    md.digest(bytes).map("%02x".format(_)).mkString
  }

  /**
    * Generic fallback parse: ensures every text file produces at least a File entity with content.
    * This avoids needing a bespoke parser for every dev/text extension.
    */
  private def genericTextParse(fileName: String, source: String): ParseResult = {
    val lines = if (source.isEmpty) 1 else source.count(_ == '\n') + 1
    ParseResult(
      entities = Vector(
        ParsedEntity(
          name = fileName,
          kind = NodeKind.File,
          attrs = Map(
            "content" -> Json.fromString(source)
          ),
          lineStart = 1,
          lineEnd = lines
        )
      ),
      relationships = Vector.empty
    )
  }
}

case class SkipReasons(
  unchanged:    Int = 0,
  emptyFile:    Int = 0,
  parseError:   Int = 0,
  tooLarge:     Int = 0
)

case class IngestionResult(
  filesProcessed:  Int,
  patchesApplied:  Int,
  filesSkipped:    Int,
  entitiesCreated: Int,
  latestRev:       Rev,
  skipReasons:     SkipReasons = SkipReasons()
)
