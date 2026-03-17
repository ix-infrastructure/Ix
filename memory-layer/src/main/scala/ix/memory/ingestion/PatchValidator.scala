package ix.memory.ingestion

import ix.memory.model.GraphPatch

/**
 * Simple validation for graph patches before committing.
 */
object PatchValidator {

  def validate(patch: GraphPatch): Either[String, GraphPatch] = {
    if (patch.ops.isEmpty)
      Left("Patch has no operations")
    else
      Right(patch)
  }
}
