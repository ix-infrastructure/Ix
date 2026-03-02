package ix.memory.model

import io.circe.{Decoder, Encoder}
import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}

final case class ScoredClaim(
  claim:      Claim,
  confidence: ConfidenceBreakdown
)

object ScoredClaim {
  implicit val encoder: Encoder[ScoredClaim] = deriveEncoder[ScoredClaim]
  implicit val decoder: Decoder[ScoredClaim] = deriveDecoder[ScoredClaim]
}

final case class ConflictReport(
  id:             ConflictId,
  claimA:         ClaimId,
  claimB:         ClaimId,
  reason:         String,
  recommendation: String
)

object ConflictReport {
  implicit val encoder: Encoder[ConflictReport] = deriveEncoder[ConflictReport]
  implicit val decoder: Decoder[ConflictReport] = deriveDecoder[ConflictReport]
}

final case class ContextMetadata(
  query:        String,
  seedEntities: List[NodeId],
  hopsExpanded: Int,
  asOfRev:      Rev
)

object ContextMetadata {
  implicit val encoder: Encoder[ContextMetadata] = deriveEncoder[ContextMetadata]
  implicit val decoder: Decoder[ContextMetadata] = deriveDecoder[ContextMetadata]
}

final case class StructuredContext(
  claims:    List[ScoredClaim],
  conflicts: List[ConflictReport],
  nodes:     List[GraphNode],
  edges:     List[GraphEdge],
  metadata:  ContextMetadata
)

object StructuredContext {
  implicit val encoder: Encoder[StructuredContext] = deriveEncoder[StructuredContext]
  implicit val decoder: Decoder[StructuredContext] = deriveDecoder[StructuredContext]
}
