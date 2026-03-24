package ix.memory.ingestion

import java.nio.file.{Files, Path}

import cats.effect.IO
import cats.syntax.all._
import cats.effect.implicits._
import io.circe.Json
import io.circe.syntax._
import org.typelevel.log4cats.slf4j.Slf4jLogger
import org.typelevel.log4cats.Logger

import ix.memory.db.{BulkWriteApi, FileBatch, GraphQueryApi}
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
  private val ParseBatchSize = 100
  private val MaxCommitFiles = 100
  private val MaxCommitPayloadBytes = 1024 * 1024
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
      files <- discoverFiles(path, language, recursive)
      _     <- onProgress(IngestionProgress(files.size, 0, 0, 0))
      latestRev <- queryApi.getLatestRev
      state <- files.grouped(ParseBatchSize).toVector.foldLeft(IO.pure(BulkIngestionState.empty(latestRev.value))) {
        case (stateIO, batch) =>
          stateIO.flatMap(processBatch(batch, force, files.size, onProgress, _))
      }
    } yield IngestionResult(
      filesProcessed  = files.size,
      patchesApplied  = state.patchesApplied,
      filesSkipped    = state.skipped.total,
      entitiesCreated = state.entitiesCreated,
      latestRev       = Rev(state.currentRev),
      skipReasons     = state.skipped
    )
  }

  private def processBatch(
    files: List[Path],
    force: Boolean,
    discovered: Int,
    onProgress: IngestionProgress => IO[Unit],
    state: BulkIngestionState
  ): IO[BulkIngestionState] = {
    for {
      hashMap <- if (force) IO.pure(Map.empty[String, String]) else loadExistingHashes(files)
      outcomes <- files.parTraverseN(parallelism) { f =>
        parseFile(f, hashMap).handleErrorWith { err =>
          logger.warn(s"Parse error: ${f.toString} - ${err.getMessage}") *>
            IO.pure(Skipped("parseError"): ParseOutcome)
        }
      }
      validBatches = outcomes.collect { case Parsed(batch) => batch }.toVector
      batchSkipped = SkipReasons(
        unchanged = outcomes.count { case Skipped("unchanged") => true; case _ => false },
        emptyFile = outcomes.count { case Skipped("emptyFile") => true; case _ => false },
        parseError = outcomes.count { case Skipped("parseError") => true; case _ => false },
        tooLarge = outcomes.count { case Skipped("tooLarge") => true; case _ => false }
      )
      parsedFiles = state.filesParsed + outcomes.size
      commitChunks = chunkForCommit(validBatches)
      totalChunks = state.totalChunksPlanned + commitChunks.size
      _ <- onProgress(IngestionProgress(discovered, parsedFiles, state.chunksWritten, totalChunks))
      committed <- commitChunks.foldLeft(IO.pure((state.currentRev, state.chunksWritten))) {
        case (revIO, chunk) =>
          revIO.flatMap { case (currentRev, chunksWritten) =>
            bulkWriteApi.commitBatch(chunk, currentRev).flatMap { result =>
              val updatedChunks = chunksWritten + 1
              onProgress(IngestionProgress(discovered, parsedFiles, updatedChunks, totalChunks)) *>
                IO.pure((result.newRev.value, updatedChunks))
            }
          }
      }
      entitiesCreated = validBatches.flatMap(_.patch.ops.collect { case _: PatchOp.UpsertNode => 1 }).size
    } yield state.copy(
      currentRev = committed._1,
      filesParsed = parsedFiles,
      patchesApplied = state.patchesApplied + validBatches.size,
      chunksWritten = committed._2,
      totalChunksPlanned = totalChunks,
      entitiesCreated = state.entitiesCreated + entitiesCreated,
      skipped = combineSkipReasons(state.skipped, batchSkipped)
    )
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
                              case None    => GenericTextFallback.parse(filePath.getFileName.toString, source)
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

  private def loadExistingHashes(files: Seq[Path]): IO[Map[String, String]] = {
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
      if (language.isEmpty || FileDiscovery.matchesFilter(path, extensions)) List(path) else List.empty
    } else if (Files.isDirectory(path)) {
      // Try git ls-files first (respects .gitignore), fall back to manual walk
      FileDiscovery.tryGitLsFiles(path, recursive, extensions)
        .getOrElse(FileDiscovery.walkFiles(path, recursive, extensions))
    } else List.empty
  }

  private def chunkForCommit(batches: Vector[FileBatch]): Vector[Vector[FileBatch]] = {
    val chunks = Vector.newBuilder[Vector[FileBatch]]
    var current = Vector.empty[FileBatch]
    var currentBytes = 0

    batches.foreach { batch =>
      val batchBytes = batch.estimatedPayloadBytes
      val exceedsPayload = current.nonEmpty && currentBytes + batchBytes > MaxCommitPayloadBytes
      val exceedsCount = current.size >= MaxCommitFiles
      if (exceedsPayload || exceedsCount) {
        chunks += current
        current = Vector.empty
        currentBytes = 0
      }
      current = current :+ batch
      currentBytes += batchBytes
    }

    if (current.nonEmpty) {
      chunks += current
    }

    chunks.result()
  }

  private def combineSkipReasons(left: SkipReasons, right: SkipReasons): SkipReasons =
    SkipReasons(
      unchanged = left.unchanged + right.unchanged,
      emptyFile = left.emptyFile + right.emptyFile,
      parseError = left.parseError + right.parseError,
      tooLarge = left.tooLarge + right.tooLarge
    )

  private def sha256Bytes(bytes: Array[Byte]): String = {
    val md = java.security.MessageDigest.getInstance("SHA-256")
    md.digest(bytes).map("%02x".format(_)).mkString
  }

}

private[ingestion] final case class BulkIngestionState(
  currentRev: Long,
  filesParsed: Int,
  patchesApplied: Int,
  chunksWritten: Int,
  totalChunksPlanned: Int,
  entitiesCreated: Int,
  skipped: SkipReasons
)

private[ingestion] object BulkIngestionState {
  def empty(baseRev: Long): BulkIngestionState =
    BulkIngestionState(
      currentRev = baseRev,
      filesParsed = 0,
      patchesApplied = 0,
      chunksWritten = 0,
      totalChunksPlanned = 0,
      entitiesCreated = 0,
      skipped = SkipReasons()
    )
}
