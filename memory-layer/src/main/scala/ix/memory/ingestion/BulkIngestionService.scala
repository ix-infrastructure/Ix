package ix.memory.ingestion

import java.nio.file.{Files, Path}

import cats.effect.IO
import cats.syntax.all._
import cats.effect.implicits._
import io.circe.Json
import io.circe.syntax._
import org.typelevel.log4cats.slf4j.Slf4jLogger
import org.typelevel.log4cats.Logger

import ix.memory.db.{BulkWriteApi, CommitResult, CommitStatus, FileBatch, GraphQueryApi}
import ix.memory.model._

private[ingestion] sealed trait ParseOutcome
private[ingestion] case class Parsed(batch: FileBatch)   extends ParseOutcome
private[ingestion] case class Skipped(reason: String)    extends ParseOutcome

/**
 * High-performance ingestion service that:
 * 1. Discovers files (with optional language filter)
 * 2. Parses files in parallel (bounded by CPU cores)
 * 3. Batches parsed results
 * 4. Bulk-inserts via Document API
 */
class BulkIngestionService(
  parserRouter: ParserRouter,
  bulkWriteApi: BulkWriteApi,
  queryApi: GraphQueryApi
) {

  private val parallelism = Runtime.getRuntime.availableProcessors.max(2)
  private val MaxFileBytes: Long = 1024 * 1024  // 1 MB
  private val mapper = new com.fasterxml.jackson.databind.ObjectMapper()
  private val logger: Logger[IO] = Slf4jLogger.getLoggerFromName[IO]("ix.ingestion")

  /**
   * Ingest files under a path using parallel parsing and bulk writes.
   */
  def ingestPath(
    path: Path,
    language: Option[String],
    recursive: Boolean,
    onProgress: IngestionProgress => IO[Unit] = _ => IO.unit,
    force: Boolean = false
  ): IO[IngestionResult] = {
    for {
      files      <- discoverFiles(path, language, recursive)
      _          <- onProgress(IngestionProgress(files.size, 0, 0, 0))
      hashMap    <- if (force) IO.pure(Map.empty[String, String]) else loadExistingHashes(files)
      outcomes   <- files.parTraverseN(parallelism) { f =>
        parseFile(f, hashMap).handleErrorWith { err =>
          logger.warn(s"Parse error: ${f.toString} — ${err.getMessage}") *>
            IO.pure(Skipped("parseError"): ParseOutcome)
        }
      }
      validBatches   = outcomes.collect { case Parsed(b) => b }
      unchangedCount = outcomes.count { case Skipped("unchanged") => true; case _ => false }
      emptyCount     = outcomes.count { case Skipped("emptyFile") => true; case _ => false }
      errorCount     = outcomes.count { case Skipped("parseError") => true; case _ => false }
      tooLargeCount  = outcomes.count { case Skipped("tooLarge") => true; case _ => false }
      skippedCount   = unchangedCount + emptyCount + errorCount + tooLargeCount
      totalChunks    = if (validBatches.isEmpty) 0 else (validBatches.size + 99) / 100
      _          <- onProgress(IngestionProgress(files.size, outcomes.size, 0, totalChunks))
      latestRev  <- queryApi.getLatestRev
      result     <- if (validBatches.isEmpty) IO.pure(CommitResult(latestRev, CommitStatus.Ok))
                    else commitChunkedWithProgress(validBatches.toVector, latestRev.value, onProgress, files.size, outcomes.size)
    } yield IngestionResult(
      filesProcessed  = files.size,
      patchesApplied  = validBatches.size,
      filesSkipped    = skippedCount,
      entitiesCreated = validBatches.flatMap(_.patch.ops.collect { case _: PatchOp.UpsertNode => 1 }).size,
      latestRev       = result.newRev,
      skipReasons     = SkipReasons(unchanged = unchangedCount, emptyFile = emptyCount, parseError = errorCount, tooLarge = tooLargeCount)
    )
  }

  private def commitChunkedWithProgress(
    batches: Vector[FileBatch],
    baseRev: Long,
    onProgress: IngestionProgress => IO[Unit],
    discovered: Int,
    parsed: Int
  ): IO[CommitResult] = {
    val chunkSize = 100
    val chunks = batches.grouped(chunkSize).toVector
    val totalChunks = chunks.size

    chunks.zipWithIndex.foldLeft(IO.pure(baseRev)) { case (revIO, (chunk, idx)) =>
      revIO.flatMap { currentRev =>
        bulkWriteApi.commitBatch(chunk, currentRev).flatMap { result =>
          onProgress(IngestionProgress(discovered, parsed, idx + 1, totalChunks)) *>
            IO.pure(result.newRev.value)
        }
      }
    }.map(finalRev => CommitResult(Rev(finalRev), CommitStatus.Ok))
  }

  /**
   * Parse a single file into a FileBatch (or None if unchanged).
   */
  private def parseFile(filePath: Path, hashMap: Map[String, String]): IO[ParseOutcome] = {
    for {
      fileSize <- IO.blocking(Files.size(filePath))
      result   <- if (fileSize > MaxFileBytes) IO.pure(Skipped("tooLarge"): ParseOutcome)
                  else if (fileSize == 0L) IO.pure(Skipped("emptyFile"): ParseOutcome)
                  else {
                    for {
                      bytes <- IO.blocking(Files.readAllBytes(filePath))
                      hash   = sha256Bytes(bytes)
                      outcome <- hashMap.get(filePath.toString) match {
                        case Some(existingHash) if existingHash == hash =>
                          IO.pure(Skipped("unchanged"): ParseOutcome)
                        case _ =>
                          for {
                            source <- IO.blocking {
                              try new String(bytes, java.nio.charset.StandardCharsets.UTF_8)
                              catch { case _: Throwable => new String(bytes, java.nio.charset.StandardCharsets.ISO_8859_1) }
                            }
                            parserOpt = parserRouter.parserFor(filePath.toString)
                            parseResult = parserOpt match {
                              case Some(p) => p.parse(filePath.getFileName.toString, source)
                              case None    => genericTextParse(filePath.getFileName.toString, source)
                            }
                            patch = GraphPatchBuilder.build(filePath.toString, Some(hash), parseResult)
                            _ <- IO.fromEither(PatchValidator.validate(patch).left.map(msg => new IllegalStateException(msg)))
                            provenance = buildProvenanceMap(patch)
                          } yield Parsed(FileBatch(filePath.toString, Some(hash), patch, provenance)): ParseOutcome
                      }
                    } yield outcome
                  }
    } yield result
  }

  private def loadExistingHashes(files: List[Path]): IO[Map[String, String]] = {
    val paths = files.map(_.toString)
    queryApi.getSourceHashes(paths)
  }

  private def buildProvenanceMap(patch: GraphPatch): java.util.Map[String, AnyRef] = {
    val json = Json.obj(
      "source_uri"  -> Json.fromString(patch.source.uri),
      "source_hash" -> patch.source.sourceHash.fold(Json.Null)(Json.fromString),
      "extractor"   -> Json.fromString(patch.source.extractor),
      "source_type" -> Json.fromString(patch.source.sourceType.asJson.asString.getOrElse("code")),
      "observed_at" -> Json.fromString(patch.timestamp.toString)
    )
    mapper.readValue(json.noSpaces, classOf[java.util.Map[String, AnyRef]])
  }

  private def discoverFiles(
    path: Path,
    language: Option[String],
    recursive: Boolean
  ): IO[List[Path]] = IO.blocking {
    val extensions = FileDiscovery.extensionsFor(language)
    if (Files.isRegularFile(path)) {
      if (FileDiscovery.matchesFilter(path, extensions)) List(path) else List.empty
    } else if (Files.isDirectory(path)) {
      // Try git ls-files first (respects .gitignore), fall back to manual walk
      FileDiscovery.tryGitLsFiles(path, recursive, extensions)
        .getOrElse(FileDiscovery.walkFiles(path, recursive, extensions))
    } else List.empty
  }

  private def sha256Bytes(bytes: Array[Byte]): String = {
    val md = java.security.MessageDigest.getInstance("SHA-256")
    md.digest(bytes).map("%02x".format(_)).mkString
  }

  private def genericTextParse(fileName: String, source: String): ParseResult = {
    val lines = if (source.isEmpty) 1 else source.count(_ == '\n') + 1
    ParseResult(
      entities = Vector(ParsedEntity(
        name = fileName, kind = NodeKind.File,
        attrs = Map("content" -> Json.fromString(source)),
        lineStart = 1, lineEnd = lines
      )),
      relationships = Vector.empty
    )
  }
}
