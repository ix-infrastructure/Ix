package ix.memory.model

import java.time.Instant

import io.circe.{Decoder, Encoder}
import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}

sealed trait SourceType
object SourceType {
  case object Code     extends SourceType
  case object Config   extends SourceType
  case object Doc      extends SourceType
  case object Test     extends SourceType
  case object Schema   extends SourceType
  case object Commit   extends SourceType
  case object Comment  extends SourceType
  case object Inferred extends SourceType
  case object Human    extends SourceType

  /** Base authority weight for confidence scoring. */
  def baseAuthority(st: SourceType): Double = st match {
    case Code     => 0.90
    case Config   => 0.85
    case Doc      => 0.70
    case Test     => 0.95
    case Schema   => 0.90
    case Commit   => 0.80
    case Comment  => 0.60
    case Inferred => 0.50
    case Human    => 0.75
  }

  private val nameMap: Map[String, SourceType] = Map(
    "Code"     -> Code,
    "Config"   -> Config,
    "Doc"      -> Doc,
    "Test"     -> Test,
    "Schema"   -> Schema,
    "Commit"   -> Commit,
    "Comment"  -> Comment,
    "Inferred" -> Inferred,
    "Human"    -> Human
  )

  implicit val encoder: Encoder[SourceType] = Encoder[String].contramap {
    case Code     => "Code"
    case Config   => "Config"
    case Doc      => "Doc"
    case Test     => "Test"
    case Schema   => "Schema"
    case Commit   => "Commit"
    case Comment  => "Comment"
    case Inferred => "Inferred"
    case Human    => "Human"
  }

  implicit val decoder: Decoder[SourceType] = Decoder[String].emap { s =>
    nameMap.get(s).toRight(s"Unknown SourceType: $s")
  }
}

final case class Provenance(
  sourceUri:  String,
  sourceHash: String,
  extractor:  String,
  sourceType: SourceType,
  observedAt: Instant
)

object Provenance {
  implicit val instantEncoder: Encoder[Instant] = Encoder[String].contramap(_.toString)
  implicit val instantDecoder: Decoder[Instant] = Decoder[String].emap { s =>
    try Right(Instant.parse(s))
    catch { case e: Exception => Left(s"Invalid instant: $s") }
  }

  implicit val encoder: Encoder[Provenance] = deriveEncoder[Provenance]
  implicit val decoder: Decoder[Provenance] = deriveDecoder[Provenance]
}
