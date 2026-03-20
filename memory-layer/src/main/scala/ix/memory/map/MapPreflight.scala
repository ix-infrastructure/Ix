package ix.memory.map

import cats.effect.IO
import org.typelevel.log4cats.slf4j.Slf4jLogger

/**
 * Preflight check between cheap file discovery and the expensive graph stages.
 *
 * Estimates workload cost, probes local capacity, classifies risk, and
 * selects an execution mode — all before any AQL coupling queries run.
 */
class MapPreflight {

  private val logger = Slf4jLogger.getLoggerFromName[IO]("ix.map.preflight")

  def evaluate(files: Vector[FileVertex]): IO[MapPreflightResult] =
    for {
      start    <- IO(System.currentTimeMillis())
      cost      = estimateCost(files)
      capacity <- probeCapacity()
      risk      = classifyRisk(cost, capacity)
      mode      = selectMode(risk, capacity)
      warnings  = buildWarnings(cost, capacity, risk, mode)
      end      <- IO(System.currentTimeMillis())
      result    = MapPreflightResult(cost, capacity, risk, mode, warnings, end - start)
      _        <- logger.debug(
        s"Preflight: F=${cost.fileCount} D=${cost.directoryCount} " +
        s"D2=${cost.directoryQuadratic} risk=${risk.label} mode=${mode.label} " +
        s"duration=${result.durationMs}ms"
      )
    } yield result

  private def estimateCost(files: Vector[FileVertex]): CostEstimate = {
    val fileCount = files.size
    val byDir = files.groupBy { v =>
      val parts = v.path.split("[/\\\\]")
      if (parts.length > 1) parts.dropRight(1).mkString("/") else "."
    }
    val directoryCount = byDir.size
    val directoryQuadratic = byDir.values.map { dirFiles =>
      val n = dirFiles.size.toLong
      n * n
    }.sum

    CostEstimate(
      fileCount          = fileCount,
      directoryCount     = directoryCount,
      directoryQuadratic = directoryQuadratic,
      symbolEstimate     = fileCount.toLong * 12,
      edgeEstimate       = fileCount.toLong * 8
    )
  }

  private def probeCapacity(): IO[LocalCapacity] = IO {
    val rt = Runtime.getRuntime
    val cpuCores     = rt.availableProcessors()
    val heapMaxBytes = rt.maxMemory()
    val heapFreeBytes = rt.freeMemory() + (heapMaxBytes - rt.totalMemory())

    // Try cgroup v2 first, then v1, for container memory limit
    val containerMemory = readCgroupMemory()

    LocalCapacity(
      cpuCores        = cpuCores,
      heapMaxBytes    = heapMaxBytes,
      heapFreeBytes   = heapFreeBytes,
      containerMemory = containerMemory,
      diskFreeBytes   = None
    )
  }

  private def readCgroupMemory(): Option[Long] = {
    // cgroup v2
    val v2 = tryReadLong("/sys/fs/cgroup/memory.max")
    if (v2.isDefined) return v2

    // cgroup v1
    tryReadLong("/sys/fs/cgroup/memory/memory.limit_in_bytes")
  }

  private def tryReadLong(path: String): Option[Long] =
    try {
      val content = scala.io.Source.fromFile(path).mkString.trim
      if (content == "max") None else Some(content.toLong)
    } catch {
      case _: Exception => None
    }

  private val LowThreshold    = 500
  private val MediumThreshold = 2000
  private val HighThreshold   = 5000
  private val LowMemoryBytes  = 512L * 1024 * 1024  // 512 MB

  private def classifyRisk(cost: CostEstimate, capacity: LocalCapacity): RiskTier = {
    val lowMem = capacity.containerMemory.exists(_ < LowMemoryBytes)
    val f = cost.fileCount

    // Lower thresholds when running in a constrained container
    val (medT, highT, extremeT) =
      if (lowMem) (300, 1200, 3000)
      else        (LowThreshold, MediumThreshold, HighThreshold)

    if (f < medT)          RiskTier.Low
    else if (f < highT)    RiskTier.Medium
    else if (f < extremeT) RiskTier.High
    else                    RiskTier.Extreme
  }

  private def selectMode(risk: RiskTier, capacity: LocalCapacity): MapExecutionMode =
    risk match {
      case RiskTier.Extreme => MapExecutionMode.FastLocal
      case RiskTier.High if capacity.heapFreeBytes < 256L * 1024 * 1024 =>
        MapExecutionMode.FastLocal
      case _ => MapExecutionMode.FullLocal
    }

  private def buildWarnings(
    cost:     CostEstimate,
    capacity: LocalCapacity,
    risk:     RiskTier,
    mode:     MapExecutionMode
  ): Vector[String] = {
    val buf = Vector.newBuilder[String]

    if (risk == RiskTier.High || risk == RiskTier.Extreme)
      buf += s"Large workload detected: ${cost.fileCount} files, ${cost.directoryCount} directories"

    if (cost.directoryQuadratic > 50000)
      buf += s"Path-proximity cost is high (D²=${cost.directoryQuadratic})"

    capacity.containerMemory.foreach { mem =>
      if (mem < LowMemoryBytes)
        buf += s"Container memory is low (${mem / (1024 * 1024)}MB)"
    }

    if (capacity.heapFreeBytes < 128L * 1024 * 1024)
      buf += s"JVM heap is low (${capacity.heapFreeBytes / (1024 * 1024)}MB free)"

    if (mode == MapExecutionMode.FastLocal)
      buf += "Full local map is not recommended for this workload"

    buf.result()
  }
}
